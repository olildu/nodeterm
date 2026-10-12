// Input: Indigo HID messages through SimulatorKit's SimDeviceLegacyHIDClient (what idb uses).
// Touch, edge gestures, pinch, hardware buttons and a HID keyboard — no Simulator.app needed.
//
// Hard-won rules (see the spike findings):
//  * NEVER send the legacy Siri button source (0x400002): it crashes the guest's backboardd.
//    "siri" is Consumer-page usage 0xCF on target 0x32.
//  * A drag needs intermediate moves; one big jump does not scroll. Each "move" is another down message.
//  * arm64: exact non-variadic objc_msgSend prototypes only.
#import "sh.h"
#include <unistd.h>
#include <dlfcn.h>

typedef struct { uint8_t raw[0xB0]; } IndigoMessage;  // opaque; the builders hand us malloc'd blocks
typedef void *(*MsgForMouseFn)(CGPoint *, CGPoint *, uint32_t, NSUInteger, CGSize, uint32_t);
typedef void *(*MsgForButtonFn)(int32_t source, int32_t dir, int32_t target);
typedef void *(*MsgForKeyboardFn)(int32_t keyCode, int32_t dir);
typedef void *(*MsgForHIDArbFn)(int32_t target, uint32_t page, uint32_t usage, int32_t dir);

#pragma pack(push, 4)
typedef struct {
  unsigned int field1, field2, eventMask;
  double xRatio, yRatio, field6, field7, field8;
  unsigned int range, touch, field11, field12, field13;
  double field14, field15, field16, field17, field18;
} IndigoTouch;
#pragma pack(pop)

static MsgForMouseFn gMouse; static MsgForButtonFn gButton; static MsgForKeyboardFn gKeyboard; static MsgForHIDArbFn gHIDArb;
static id gClient, gDev;
static NSString *gUdid;
static dispatch_queue_t gQ;
static dispatch_group_t gAcks;
static BOOL gBroken;           // a send failed: recreate the client before the next command
static NSString *gLastSendErr;

// held touch
static BOOL gTouchDown; static double gTx, gTy; static uint32_t gTEdge;

BOOL sh_input_ready(void) { return gClient != nil; }

BOOL sh_input_setup(id dev, NSString **err) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    void *sk = dlopen([[sh_developer_dir() stringByAppendingString:@"/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"] UTF8String], RTLD_NOW);
    if (!sk) return;
    gMouse = dlsym(sk, "IndigoHIDMessageForMouseNSEvent");
    gButton = dlsym(sk, "IndigoHIDMessageForButton");
    gKeyboard = dlsym(sk, "IndigoHIDMessageForKeyboardArbitrary");
    gHIDArb = dlsym(sk, "IndigoHIDMessageForHIDArbitrary");
    gQ = dispatch_queue_create("simhelper.hid", DISPATCH_QUEUE_SERIAL);
    gAcks = dispatch_group_create();
  });
  if (!gMouse || !gButton || !gKeyboard || !gHIDArb) { if (err) *err = @"SimulatorKit is missing the Indigo HID builders (Xcode changed?)"; return NO; }
  __block id client = nil;
  if (!sh_try(err, ^{
    Class cls = objc_getClass("_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
    if (!cls) { if (err) *err = @"SimDeviceLegacyHIDClient class not found"; return; }
    NSError *e = nil;
    client = ((id (*)(id, SEL, id, NSError **))objc_msgSend)([cls alloc], SH_SEL("initWithDevice:error:"), dev, &e);
    if (!client && err) *err = [NSString stringWithFormat:@"HID client init failed: %@", e];
  }) || !client) return NO;
  gClient = client; gDev = dev; gBroken = NO;
  gUdid = [SH_GET(id, dev, "UDID") UUIDString];
  return YES;
}

void sh_input_teardown(void) { gClient = nil; gTouchDown = NO; }

// ---- low-level send ------------------------------------------------------------------------
static void sendMsg(void *m) {
  if (!m) return;
  dispatch_group_enter(gAcks);
  void (^done)(NSError *) = ^(NSError *e) {
    if (e) { gBroken = YES; gLastSendErr = e.description; sh_log(@"HID send error: %@", e); }
    dispatch_group_leave(gAcks);
  };
  id c = gClient;
  NSString *x = nil;
  BOOL ok = sh_try(&x, ^{
    ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, id))objc_msgSend)(c,
        SH_SEL("sendWithMessage:freeWhenDone:completionQueue:completion:"), m, YES, gQ, done);
  });
  if (!ok) { gBroken = YES; gLastSendErr = x; dispatch_group_leave(gAcks); }
}
static BOOL waitAcks(void) {
  // A dead device never acks; do not hang the command queue forever.
  if (dispatch_group_wait(gAcks, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC)) != 0) {
    gBroken = YES; gLastSendErr = @"HID ack timeout"; return NO;
  }
  return !gBroken;
}

static CGPoint ratioFor(double xPt, double yPt) {
  CGSize px = sh_display_px(); float sc = sh_display_scale();
  return CGPointMake(xPt * sc / px.width, yPt * sc / px.height);
}
static CGSize pointSize(void) { CGSize px = sh_display_px(); float sc = sh_display_scale(); return CGSizeMake(px.width / sc, px.height / sc); }

static void touch1(double x, double y, BOOL down, uint32_t edge) {
  CGPoint p = ratioFor(x, y);
  // With p2 == NULL the builder returns a complete single-touch message (size 384, two contacts); send as is.
  sendMsg(gMouse(&p, NULL, 0x32, down ? 1 : 2, CGSizeMake(1, 1), edge));
}

// Two-finger: the builder emits a 3-payload message (wire stride 0xA0); patch the contact ratios.
static void touch2(CGPoint a, CGPoint b, BOOL down) {
  CGPoint r1 = ratioFor(a.x, a.y), r2 = ratioFor(b.x, b.y);
  uint8_t *m = gMouse(&r1, &r2, 0x32, down ? 1 : 2, CGSizeMake(1, 1), 0);
  if (!m) return;
  // The message is {mach header 0x18, innerSize, eventType, payloads...}; each payload is {kind u32,
  // timestamp u64 (pack 4), u32, IndigoTouch at +0x10}. The three payloads start at 0x20, 0xC0, 0x160.
  IndigoTouch *c1 = (IndigoTouch *)(m + 0x20 + 0x10), *c2 = (IndigoTouch *)(m + 0xC0 + 0x10), *c3 = (IndigoTouch *)(m + 0x160 + 0x10);
  c1->xRatio = r1.x; c1->yRatio = r1.y;
  c2->xRatio = r1.x; c2->yRatio = r1.y;
  c3->xRatio = r2.x; c3->yRatio = r2.y;
  sendMsg(m);
}

static void buttonMsg(NSString *name, BOOL down, NSString **err) {
  // Legacy sources: home=0, lock=1, side=0xbb8. Siri is deliberately NOT here (see header).
  NSDictionary *src = @{ @"home": @0, @"lock": @1, @"side": @0xbb8 };
  NSDictionary *usage = @{ @"volup": @0xE9, @"voldown": @0xEA, @"playpause": @0xCD, @"siri": @0xCF };
  if (src[name]) sendMsg(gButton([src[name] intValue], down ? 1 : 2, 0x33));
  else if (usage[name]) sendMsg(gHIDArb(0x32, 0x0C, [usage[name] unsignedIntValue], down ? 1 : 2));
  else if (err) *err = [NSString stringWithFormat:@"unknown button '%@' (home|lock|side|siri|volup|voldown|playpause)", name];
}

static void keyMsg(uint32_t usage, BOOL down) { sendMsg(gKeyboard((int32_t)usage, down ? 1 : 2)); }

// US-ASCII -> (HID usage page 7, shift)
static BOOL usageFor(unichar c, uint32_t *u, BOOL *shift) {
  *shift = NO;
  if (c >= 'a' && c <= 'z') { *u = 4 + (c - 'a'); return YES; }
  if (c >= 'A' && c <= 'Z') { *u = 4 + (c - 'A'); *shift = YES; return YES; }
  if (c >= '1' && c <= '9') { *u = 30 + (c - '1'); return YES; }
  if (c == '0') { *u = 39; return YES; }
  const char *plain = "\n\t -=[]\\;'`,./", *shifted = "!@#$%^&*()_+{}|:\"~<>?";
  uint32_t plainU[] = {40, 43, 44, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56};
  uint32_t shiftU[] = {30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56};
  if (c == 0 || c > 127) return NO;
  const char *q = strchr(plain, (char)c); if (q) { *u = plainU[q - plain]; return YES; }
  q = strchr(shifted, (char)c); if (q) { *u = shiftU[q - shifted]; *shift = YES; return YES; }
  return NO;
}

static BOOL pasteText(NSString *text, NSString **err) {
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcrun"];
  t.arguments = @[@"simctl", @"pbcopy", gUdid];
  NSMutableDictionary *env = [NSProcessInfo.processInfo.environment mutableCopy];
  env[@"DEVELOPER_DIR"] = sh_developer_dir();
  t.environment = env;
  NSPipe *in = [NSPipe pipe]; t.standardInput = in;
  t.standardOutput = [NSFileHandle fileHandleWithNullDevice]; t.standardError = [NSFileHandle fileHandleWithNullDevice];
  NSError *e = nil;
  if (![t launchAndReturnError:&e]) { if (err) *err = [NSString stringWithFormat:@"cannot run simctl pbcopy: %@", e]; return NO; }
  [in.fileHandleForWriting writeData:[text dataUsingEncoding:NSUTF8StringEncoding]];
  [in.fileHandleForWriting closeFile];
  double dl = sh_now_ms() + 5000;
  while (t.isRunning && sh_now_ms() < dl) usleep(5000);
  if (t.isRunning) { [t terminate]; if (err) *err = @"simctl pbcopy timed out"; return NO; }
  if (t.terminationStatus != 0) { if (err) *err = [NSString stringWithFormat:@"simctl pbcopy exited %d", t.terminationStatus]; return NO; }
  usleep(100 * 1000);  // the guest's pasteboard sync lags the pbcopy exit
  // Cmd+V
  keyMsg(227, YES); keyMsg(25, YES); keyMsg(25, NO); keyMsg(227, NO);
  waitAcks();
  usleep(250 * 1000);  // let the guest consume the paste before further keystrokes
  return YES;
}

static uint32_t modUsage(NSString *m) {
  m = m.lowercaseString;
  if ([m isEqual:@"ctrl"] || [m isEqual:@"control"]) return 224;
  if ([m isEqual:@"shift"]) return 225;
  if ([m isEqual:@"alt"] || [m isEqual:@"opt"] || [m isEqual:@"option"]) return 226;
  if ([m isEqual:@"cmd"] || [m isEqual:@"meta"] || [m isEqual:@"command"]) return 227;
  return 0;
}

static uint32_t edgeFrom(id v) {
  if ([v isKindOfClass:NSNumber.class]) return [v unsignedIntValue] > 4 ? 0 : [v unsignedIntValue];
  if (![v isKindOfClass:NSString.class]) return 0;
  NSDictionary *e = @{ @"none": @0, @"top": @1, @"left": @2, @"bottom": @3, @"right": @4 };
  return e[[v lowercaseString]] ? [e[[v lowercaseString]] unsignedIntValue] : 0;
}

static NSDictionary *errd(NSString *code, NSString *msg) { return @{ @"code": code, @"message": msg }; }

#define NEED(key, var) \
  double var; { id _v = req[@key]; if (![_v isKindOfClass:NSNumber.class] || isnan([_v doubleValue]) || isinf([_v doubleValue])) \
    return errd(@"bad-request", @"missing or non-numeric '" key "'"); var = [_v doubleValue]; }
static double optNum(NSDictionary *req, NSString *k, double d) { id v = req[k]; return [v isKindOfClass:NSNumber.class] ? [v doubleValue] : d; }
static double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

void sh_input_release_touch(void) {
  if (gTouchDown && gClient) { touch1(gTx, gTy, NO, gTEdge); waitAcks(); }
  gTouchDown = NO;
}

NSDictionary *sh_input_run(NSDictionary *req) {
  NSString *cmd = req[@"cmd"];
  if (!gClient || sh_device_state(gDev) != 3) return errd(@"not-ready", @"device is not booted / HID client not available");
  if (gBroken) {  // previous send failed (backboardd restart / device bounce): rebuild once, then carry on
    NSString *e = nil;
    gClient = nil; gTouchDown = NO;
    if (!sh_input_setup(gDev, &e)) return errd(@"hid-failed", [NSString stringWithFormat:@"HID client lost and could not be recreated: %@ (last: %@)", e, gLastSendErr]);
    sh_log(@"HID client recreated");
  }
  CGSize pt = pointSize();
  double t0 = sh_now_ms();
  BOOL quiet = [req[@"quiet"] boolValue];
  NSMutableDictionary *extra = [NSMutableDictionary dictionary];

  if ([cmd isEqual:@"touch"]) {
    NSString *phase = req[@"phase"];
    NEED("x", x) NEED("y", y)
    if ([phase isEqual:@"down"]) {
      if (x < 0 || y < 0 || x > pt.width || y > pt.height) return errd(@"out-of-bounds", [NSString stringWithFormat:@"(%g,%g) is outside the %gx%g pt screen", x, y, pt.width, pt.height]);
      if (gTouchDown) { touch1(gTx, gTy, NO, gTEdge); }   // never leave a stuck finger
      gTEdge = edgeFrom(req[@"edge"]); gTouchDown = YES; gTx = x; gTy = y;
      touch1(x, y, YES, gTEdge);
    } else if ([phase isEqual:@"move"]) {
      if (!gTouchDown) return errd(@"no-touch", @"move without a preceding down");
      gTx = clampd(x, 0, pt.width); gTy = clampd(y, 0, pt.height);
      uint32_t e = req[@"edge"] ? edgeFrom(req[@"edge"]) : gTEdge;
      touch1(gTx, gTy, YES, e);
    } else if ([phase isEqual:@"up"]) {
      if (!gTouchDown) return errd(@"no-touch", @"up without a preceding down");
      gTx = clampd(x, 0, pt.width); gTy = clampd(y, 0, pt.height);
      uint32_t e = req[@"edge"] ? edgeFrom(req[@"edge"]) : gTEdge;
      touch1(gTx, gTy, NO, e); gTouchDown = NO;
    } else return errd(@"bad-request", @"phase must be down|move|up");
    if (quiet) return @{ @"_quiet": @YES };
  } else if ([cmd isEqual:@"tap"]) {
    NEED("x", x) NEED("y", y)
    if (x < 0 || y < 0 || x > pt.width || y > pt.height) return errd(@"out-of-bounds", [NSString stringWithFormat:@"(%g,%g) is outside the %gx%g pt screen", x, y, pt.width, pt.height]);
    sh_input_release_touch();
    touch1(x, y, YES, 0);
    double hold = optNum(req, @"holdMs", 0);
    if (hold > 0) { waitAcks(); usleep((useconds_t)(clampd(hold, 0, 10000) * 1000)); }
    touch1(x, y, NO, 0);
  } else if ([cmd isEqual:@"swipe"]) {
    NEED("x1", x1) NEED("y1", y1) NEED("x2", x2) NEED("y2", y2)
    if (x1 < 0 || y1 < 0 || x1 > pt.width || y1 > pt.height) return errd(@"out-of-bounds", @"swipe start is outside the screen");
    double ms = clampd(optNum(req, @"ms", 300), 10, 20000); int steps = (int)clampd(optNum(req, @"steps", 20), 2, 400);
    uint32_t edge = edgeFrom(req[@"edge"]);
    sh_input_release_touch();
    double x2c = clampd(x2, 0, pt.width), y2c = clampd(y2, 0, pt.height);
    for (int i = 0; i <= steps; i++) {
      double f = (double)i / steps;
      touch1(x1 + (x2c - x1) * f, y1 + (y2c - y1) * f, YES, edge);
      if (i < steps) usleep((useconds_t)(ms * 1000 / steps));
    }
    touch1(x2c, y2c, NO, edge);
  } else if ([cmd isEqual:@"pinch"]) {
    NEED("cx", cx) NEED("cy", cy) NEED("r1", r1) NEED("r2", r2)
    double ms = clampd(optNum(req, @"ms", 400), 10, 20000); int steps = (int)clampd(optNum(req, @"steps", 20), 2, 400);
    double ang = optNum(req, @"angleDeg", 45) * M_PI / 180.0, dx = cos(ang), dy = sin(ang);
    sh_input_release_touch();
    for (int i = 0; i <= steps; i++) {
      double r = r1 + (r2 - r1) * i / steps;
      touch2(CGPointMake(cx - r * dx, cy - r * dy), CGPointMake(cx + r * dx, cy + r * dy), YES);
      if (i < steps) usleep((useconds_t)(ms * 1000 / steps));
    }
    touch2(CGPointMake(cx - r2 * dx, cy - r2 * dy), CGPointMake(cx + r2 * dx, cy + r2 * dy), NO);
  } else if ([cmd isEqual:@"button"]) {
    NSString *name = req[@"name"]; NSString *berr = nil;
    if (![name isKindOfClass:NSString.class]) return errd(@"bad-request", @"missing 'name'");
    buttonMsg(name.lowercaseString, YES, &berr);
    if (berr) return errd(@"bad-request", berr);
    double hold = optNum(req, @"holdMs", 0);
    if (hold > 0) { waitAcks(); usleep((useconds_t)(clampd(hold, 0, 15000) * 1000)); }
    buttonMsg(name.lowercaseString, NO, &berr);
  } else if ([cmd isEqual:@"key"]) {
    NEED("usage", usage)
    NSMutableArray<NSNumber *> *mods = [NSMutableArray array];
    for (id m in ([req[@"mods"] isKindOfClass:NSArray.class] ? req[@"mods"] : @[])) {
      uint32_t mu = [m isKindOfClass:NSString.class] ? modUsage(m) : 0;
      if (!mu) return errd(@"bad-request", [NSString stringWithFormat:@"unknown modifier %@ (ctrl|shift|alt|cmd)", m]);
      [mods addObject:@(mu)];
    }
    uint32_t u = (uint32_t)usage;
    id dn = req[@"down"];
    for (NSNumber *m in mods) keyMsg(m.unsignedIntValue, YES);
    if (dn == nil) { keyMsg(u, YES); keyMsg(u, NO); } else keyMsg(u, [dn boolValue]);
    if (dn == nil) for (NSNumber *m in mods.reverseObjectEnumerator) keyMsg(m.unsignedIntValue, NO);
  } else if ([cmd isEqual:@"text"]) {
    NSString *text = req[@"text"];
    if (![text isKindOfClass:NSString.class]) return errd(@"bad-request", @"missing 'text'");
    BOOL forcePaste = [req[@"paste"] boolValue];
    // Any char that cannot be typed (non-ASCII) => paste the WHOLE string in one go. Alternating
    // pbcopy/Cmd+V runs raced the guest's pasteboard sync (measured: runs silently dropped).
    for (NSUInteger k = 0; k < text.length && !forcePaste; k++) { uint32_t uu; BOOL sh; if (!usageFor([text characterAtIndex:k], &uu, &sh)) forcePaste = YES; }
    int delay = (int)clampd(optNum(req, @"delayMs", 0), 0, 500);
    int typed = 0, pasted = 0;
    NSMutableString *run = [NSMutableString string];
    __block NSString *perr = nil;
    BOOL runIsPaste = NO;
    // Split into maximal runs of typable ASCII (keystrokes) and everything else (pasteboard + Cmd+V).
    NSUInteger i = 0, n = text.length;
    while (i < n || run.length) {
      BOOL end = (i >= n);
      BOOL curPaste = NO;
      if (!end) {
        unichar c = [text characterAtIndex:i]; uint32_t uu; BOOL sh;
        curPaste = forcePaste || !usageFor(c, &uu, &sh);
      }
      if (run.length && (end || curPaste != runIsPaste)) {
        if (runIsPaste) { if (!pasteText(run, &perr)) return errd(@"paste-failed", perr); pasted += (int)run.length; }
        else {
          for (NSUInteger k = 0; k < run.length; k++) {
            uint32_t uu; BOOL sh; usageFor([run characterAtIndex:k], &uu, &sh);
            if (sh) keyMsg(225, YES);
            keyMsg(uu, YES); keyMsg(uu, NO);
            if (sh) keyMsg(225, NO);
            typed++;
            if (delay) { waitAcks(); usleep(delay * 1000); }
          }
        }
        [run setString:@""];
        if (end) break;
      }
      if (end) break;
      runIsPaste = curPaste;
      NSRange r = [text rangeOfComposedCharacterSequenceAtIndex:i];
      [run appendString:[text substringWithRange:r]];
      i = NSMaxRange(r);
    }
    extra[@"typed"] = @(typed); extra[@"pasted"] = @(pasted);
  } else {
    return errd(@"unknown-command", [NSString stringWithFormat:@"not an input command: %@", cmd]);
  }
  if (!waitAcks()) return errd(@"hid-failed", [NSString stringWithFormat:@"device did not accept the input (%@); will retry with a fresh HID client on the next command", gLastSendErr]);
  extra[@"ms"] = @(sh_now_ms() - t0);
  return extra;
}
