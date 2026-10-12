// Accessibility tree of the frontmost app via AXPTranslator (the path `idb ui describe-all` uses).
// Frames come back in device POINTS (top-left origin), the same space the input commands take.
//
// The AX bridge callback BLOCKS its thread waiting on the guest's XPC reply, so it waits on a
// semaphore signalled from a DIFFERENT serial queue (gCompletionQ) — never the queue the describe
// itself runs on.
#import "sh.h"
#import <AppKit/AppKit.h>
#include <unistd.h>

@interface AXPTranslator : NSObject
+ (instancetype)sharedInstance;
@property (nonatomic, weak) id bridgeTokenDelegate;
@property (nonatomic) BOOL supportsDelegateTokens;
- (id)frontmostApplicationWithDisplayId:(unsigned)displayId bridgeDelegateToken:(NSString *)token;
- (id)objectAtPoint:(CGPoint)p displayId:(unsigned)displayId bridgeDelegateToken:(NSString *)token;
- (NSAccessibilityElement *)macPlatformElementFromTranslation:(id)translation;
@end
@interface NSObject (SHSimPriv)
- (void)sendAccessibilityRequestAsync:(id)req completionQueue:(dispatch_queue_t)q completionHandler:(void (^)(id resp))h;
- (id)translation;
- (void)setBridgeDelegateToken:(NSString *)t;
@end

typedef id (^AXPBridgeCallback)(id request);

@interface SHAXBridge : NSObject
@property (strong) id device;
@property (strong) dispatch_queue_t completionQ;
@end
@implementation SHAXBridge
- (AXPBridgeCallback)accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token {
  id dev = self.device; dispatch_queue_t q = self.completionQ;
  return ^id(id request) {
    __block id response = nil;
    dispatch_semaphore_t s = dispatch_semaphore_create(0);
    @try {
      [dev sendAccessibilityRequestAsync:request completionQueue:q completionHandler:^(id r) { response = r; dispatch_semaphore_signal(s); }];
    } @catch (NSException *e) { return [objc_getClass("AXPTranslatorResponse") performSelector:@selector(emptyResponse)]; }
    if (dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC))) {
      sh_log(@"ax request timed out");
      return [objc_getClass("AXPTranslatorResponse") performSelector:@selector(emptyResponse)];
    }
    return response;
  };
}
- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)r withToken:(NSString *)t { return r; }
- (id)accessibilityTranslationRootParentWithToken:(NSString *)t { return nil; }
@end

static NSString *const kToken = @"nodeterm-sim-helper";
static SHAXBridge *gBridge;       // strong: the translator only holds it weakly
static dispatch_queue_t gDescribeQ;


// ---- Guest accessibility preference --------------------------------------------------------------
// Flutter (and other frameworks that build their accessibility tree lazily) only produce it when the
// guest says an assistive technology is on: com.apple.Accessibility ApplicationAccessibilityEnabled.
// A never-touched simulator has no such key and the translator's first request turns it on (both
// ApplicationAccessibilityEnabled and AccessibilityEnabled become 1). But an XCUITest/Maestro run
// leaves EXPLICIT zeros behind when it exits (together with AutomationEnabled/AuditInspectionModeEnabled),
// and an explicit 0 is never overridden: every Flutter app then describes as an empty tree. So on
// attach we make sure it is 1. Idempotent (one `defaults read` when already on). A running app only
// reads it at launch, hence axPref = "enabled-now" in describe replies for apps started earlier.
static dispatch_group_t gAxPrefGroup;
static BOOL gAxPrefChanged;

static NSString *runSimctl(NSArray<NSString *> *args, int *status) {
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcrun"];
  t.arguments = args;
  NSMutableDictionary *env = [NSProcessInfo.processInfo.environment mutableCopy];
  env[@"DEVELOPER_DIR"] = sh_developer_dir();
  t.environment = env;
  NSPipe *out = [NSPipe pipe]; t.standardOutput = out; t.standardError = [NSFileHandle fileHandleWithNullDevice];
  NSError *e = nil;
  if (![t launchAndReturnError:&e]) { if (status) *status = -1; return nil; }
  double dl = sh_now_ms() + 8000;
  while (t.isRunning && sh_now_ms() < dl) usleep(5000);
  if (t.isRunning) { [t terminate]; if (status) *status = -2; return nil; }
  if (status) *status = t.terminationStatus;
  NSData *d = [out.fileHandleForReading readDataToEndOfFile];
  return [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
}

static void ensureAxPref(NSString *udid) {
  gAxPrefGroup = dispatch_group_create();
  gAxPrefChanged = NO;
  dispatch_group_async(gAxPrefGroup, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    double t0 = sh_now_ms();
    int st = 0;
    NSString *cur = runSimctl(@[@"simctl", @"spawn", udid, @"defaults", @"read", @"com.apple.Accessibility", @"ApplicationAccessibilityEnabled"], &st);
    if (st == 0 && [[cur stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] isEqualToString:@"1"]) { sh_log(@"AX pref already on (%.0f ms)", sh_now_ms() - t0); return; }
    if (st < 0) { sh_log(@"AX pref check failed (simctl %d)", st); return; }
    for (NSString *k in @[@"ApplicationAccessibilityEnabled", @"AccessibilityEnabled"]) {
      (void)runSimctl(@[@"simctl", @"spawn", udid, @"defaults", @"write", @"com.apple.Accessibility", k, @"-bool", @"true"], &st);
      if (st != 0) { sh_log(@"AX pref write %@ failed (%d)", k, st); return; }
    }
    gAxPrefChanged = YES;
    sh_log(@"AX pref switched on in the guest (%.0f ms); apps started earlier need a relaunch", sh_now_ms() - t0);
  });
}

static NSString *axPrefState(void) {
  if (gAxPrefGroup) dispatch_group_wait(gAxPrefGroup, dispatch_time(DISPATCH_TIME_NOW, 6 * NSEC_PER_SEC));
  return gAxPrefChanged ? @"enabled-now" : @"on";
}

void sh_describe_setup(id dev) {
  Class tc = objc_getClass("AXPTranslator");
  if (!tc) { sh_log(@"AccessibilityPlatformTranslation unavailable; describe disabled"); return; }
  gBridge = [SHAXBridge new];
  gBridge.device = dev;
  gBridge.completionQ = dispatch_queue_create("simhelper.ax.completion", DISPATCH_QUEUE_SERIAL);
  AXPTranslator *tr = [tc sharedInstance];
  tr.bridgeTokenDelegate = gBridge;
  tr.supportsDelegateTokens = YES;
  NSString *udid = [[dev valueForKey:@"UDID"] UUIDString];
  if (udid) ensureAxPref(udid);
}
void sh_describe_teardown(void) { gBridge = nil; }

static id S(id x) { return x ?: [NSNull null]; }

static CGRect screenRect(void) {
  CGSize px = sh_display_px(); float sc = sh_display_scale();
  return CGRectMake(0, 0, px.width / sc, px.height / sc);
}

static NSDictionary *element(NSAccessibilityElement *e, int depth, CGRect screen) {
  id tr = [e respondsToSelector:@selector(translation)] ? [e translation] : nil;
  [tr setBridgeDelegateToken:kToken];
  CGRect f = e.accessibilityFrame;
  id val = e.accessibilityValue;
  if (val && ![val isKindOfClass:NSString.class] && ![val isKindOfClass:NSNumber.class]) val = [val description];
  CGRect vis = CGRectIntersection(f, screen);
  BOOL off = CGRectIsNull(vis) || vis.size.width <= 0 || vis.size.height <= 0;
  BOOL clipped = !off && (vis.size.width < f.size.width - 0.5 || vis.size.height < f.size.height - 0.5);
  NSMutableDictionary *d = [@{
    @"label": S(e.accessibilityLabel), @"identifier": S(e.accessibilityIdentifier),
    @"role": S(e.accessibilityRole), @"subrole": S(e.accessibilitySubrole),
    @"roleDescription": S(e.accessibilityRoleDescription), @"value": S(val), @"help": S(e.accessibilityHelp),
    @"enabled": @(e.isAccessibilityEnabled),
    @"frame": @{ @"x": @(f.origin.x), @"y": @(f.origin.y), @"width": @(f.size.width), @"height": @(f.size.height) },
    @"depth": @(depth),
    @"offscreen": @(off), @"clipped": @(clipped),
  } mutableCopy];
  if (!off) {
    d[@"visibleFrame"] = @{ @"x": @(vis.origin.x), @"y": @(vis.origin.y), @"width": @(vis.size.width), @"height": @(vis.size.height) };
    d[@"center"] = @{ @"x": @(CGRectGetMidX(vis)), @"y": @(CGRectGetMidY(vis)) };
  }
  return d;
}

static void walk(NSAccessibilityElement *e, int depth, CGRect screen, BOOL flat, NSMutableArray *flatOut, NSMutableDictionary *parentOut, int *count) {
  if (*count > 5000 || depth > 60) return;   // runaway-tree guard
  (*count)++;
  NSMutableDictionary *d = [element(e, depth, screen) mutableCopy];
  if (flat) [flatOut addObject:d];
  NSMutableArray *kids = flat ? nil : [NSMutableArray array];
  for (NSAccessibilityElement *c in e.accessibilityChildren ?: @[]) {
    if (flat) walk(c, depth + 1, screen, YES, flatOut, nil, count);
    else {
      NSMutableDictionary *holder = [NSMutableDictionary dictionary];
      walk(c, depth + 1, screen, NO, nil, holder, count);
      if (holder[@"node"]) [kids addObject:holder[@"node"]];
    }
  }
  if (!flat) { d[@"children"] = kids; parentOut[@"node"] = d; }
}

static dispatch_queue_t describeQ(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{ gDescribeQ = dispatch_queue_create("simhelper.describe", DISPATCH_QUEUE_SERIAL); });
  return gDescribeQ;
}

static NSDictionary *err(NSString *code, NSString *msg) { return @{ @"error": @{ @"code": code, @"message": msg } }; }

static id translationFor(BOOL point, CGPoint p) {
  AXPTranslator *tr = [objc_getClass("AXPTranslator") sharedInstance];
  id t = point ? [tr objectAtPoint:p displayId:0 bridgeDelegateToken:kToken]
               : [tr frontmostApplicationWithDisplayId:0 bridgeDelegateToken:kToken];
  [t setBridgeDelegateToken:kToken];
  return t;
}

static NSDictionary *runInner(BOOL point, CGPoint p, BOOL flat);
static NSDictionary *run(BOOL point, CGPoint p, BOOL flat) {
  NSString *pref = gBridge ? axPrefState() : nil;   // waits for the attach-time enable to finish
  NSDictionary *r = runInner(point, p, flat);
  if (!pref || r[@"error"]) return r;
  NSMutableDictionary *m = [r mutableCopy]; m[@"axPref"] = pref;
  return m;
}
static NSDictionary *runInner(BOOL point, CGPoint p, BOOL flat) {
  if (!gBridge) return err(@"not-ready", @"accessibility bridge not available (device down or AX framework missing)");
  __block NSDictionary *out = nil;
  dispatch_sync(describeQ(), ^{
    @autoreleasepool {
      NSString *x = nil;
      BOOL ok = sh_try(&x, ^{
        double t0 = sh_now_ms();
        id t = translationFor(point, p);
        // The guest's AX server answers nil transiently (mid-animation, right after a keyboard/search
        // state change). Retry briefly before calling it a failure.
        for (int attempt = 1; !t && !point && attempt <= 4; attempt++) { usleep(250 * 1000); t = translationFor(point, p); }
        BOOL viaPoint = NO;
        if (!t && !point && getenv("SH_AX_DEBUG")) {
          AXPTranslator *trd = [objc_getClass("AXPTranslator") sharedInstance];
          for (unsigned did = 0; did < 4; did++) {
            id x = [trd frontmostApplicationWithDisplayId:did bridgeDelegateToken:kToken];
            sh_log(@"AXDEBUG frontmost display %u -> %@", did, x ? @"object" : @"nil");
          }
          id pt = [trd objectAtPoint:CGPointMake(100, 400) displayId:0 bridgeDelegateToken:kToken];
          sh_log(@"AXDEBUG point -> %@ ; supportsDelegateTokens=%d", pt ? @"object" : @"nil", (int)trd.supportsDelegateTokens);
        }
        // Sometimes the guest has NO "frontmost application" (measured: right after typing into the
        // Settings search field with a hardware keyboard attached, and in a wedged AX state) although
        // hit-testing still works. Degrade to a grid of hit-tests, de-duplicated: leaves only, no
        // containers, flagged `partial` so the caller knows it is not the whole tree.
        NSMutableArray *gridFlat = nil;
        if (!t && !point) {
          CGRect sr = screenRect();
          AXPTranslator *tr0 = [objc_getClass("AXPTranslator") sharedInstance];
          NSMutableSet *seen = [NSMutableSet set];
          gridFlat = [NSMutableArray array];
          for (double y = 20; y < sr.size.height; y += 52) for (double x = 20; x < sr.size.width; x += 48) {
            id ht = translationFor(YES, CGPointMake(x, y));
            if (!ht) continue;
            NSAccessibilityElement *el = [tr0 macPlatformElementFromTranslation:ht];
            NSDictionary *d = element(el, 1, sr);
            NSString *key = [NSString stringWithFormat:@"%@|%@|%@", d[@"label"], d[@"role"], d[@"frame"]];
            if ([seen containsObject:key]) continue;
            [seen addObject:key]; [gridFlat addObject:d];
          }
          if (gridFlat.count) viaPoint = YES;
        }
        if (gridFlat.count) {
          CGRect sr = screenRect();
          if (!flat) {  // tree requested: synthesize a root so the reply shape holds
            NSMutableArray *kids = [NSMutableArray array];
            for (NSDictionary *d in gridFlat) { NSMutableDictionary *k = [d mutableCopy]; k[@"children"] = @[]; [kids addObject:k]; }
            out = @{ @"tree": @{ @"role": @"AXApplication", @"label": [NSNull null], @"depth": @0, @"children": kids }, @"count": @(gridFlat.count), @"partial": @YES, @"viaPoint": @YES,
                     @"screen": @{ @"width": @(sr.size.width), @"height": @(sr.size.height) }, @"ms": @(sh_now_ms() - t0) };
            return;
          }
          out = @{ @"elements": gridFlat, @"count": @(gridFlat.count), @"partial": @YES, @"viaPoint": @YES,
                   @"screen": @{ @"width": @(sr.size.width), @"height": @(sr.size.height) }, @"ms": @(sh_now_ms() - t0) };
          return;
        }
        if (!t) { out = point ? @{ @"element": [NSNull null], @"ms": @(sh_now_ms() - t0) } : err(@"no-translation", @"no frontmost application accessibility object"); return; }
        AXPTranslator *tr = [objc_getClass("AXPTranslator") sharedInstance];
        NSAccessibilityElement *root = [tr macPlatformElementFromTranslation:t];
        CGRect screen = screenRect();
        if (point) { out = @{ @"element": element(root, 0, screen), @"ms": @(sh_now_ms() - t0) }; return; }
        int count = 0;
        if (flat) {
          NSMutableArray *arr = [NSMutableArray array];
          walk(root, 0, screen, YES, arr, nil, &count);
          out = @{ @"elements": arr, @"count": @(arr.count), @"screen": @{ @"width": @(screen.size.width), @"height": @(screen.size.height) }, @"ms": @(sh_now_ms() - t0), @"viaPoint": @(viaPoint) };
        } else {
          NSMutableDictionary *h = [NSMutableDictionary dictionary];
          walk(root, 0, screen, NO, nil, h, &count);
          out = @{ @"tree": h[@"node"] ?: [NSNull null], @"count": @(count), @"screen": @{ @"width": @(screen.size.width), @"height": @(screen.size.height) }, @"ms": @(sh_now_ms() - t0), @"viaPoint": @(viaPoint) };
        }
      });
      if (!ok) out = err(@"describe-failed", x ?: @"exception");
    }
  });
  return out;
}

NSDictionary *sh_describe_all(BOOL flat) { return run(NO, CGPointZero, flat); }
NSDictionary *sh_describe_point(double x, double y) { return run(YES, CGPointMake(x, y), YES); }

void sh_describe_prewarm(void) {
  // The first AX call after boot costs ~2.6 s; pay it now so the agent's first describe does not.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ double t = sh_now_ms(); (void)sh_describe_all(YES); sh_log(@"AX prewarm %.0f ms", sh_now_ms() - t); });
}
