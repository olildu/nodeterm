// sim-helper — one long-lived controller process per iOS Simulator device.
//   sim-helper --version
//   sim-helper list                 JSON array of devices on stdout
//   sim-helper attach <udid>        the long-lived mode (see PROTOCOL.md)
#import "sh.h"
#include <signal.h>
#include <unistd.h>

static NSString *gUdid;
static id gDev;
static BOOL gUp;                        // capture + input + describe all set up
static unsigned long long gLastState = 99;
static NSString *gLastSetupErr;
static dispatch_queue_t gCtlQ, gInputQ, gAxQ;
static uint32_t gImageSeq;

static NSDictionary *infoBody(void) {
  NSMutableDictionary *m = [[sh_device_summary(gDev) mutableCopy] ?: [NSMutableDictionary dictionary] mutableCopy];
  CGSize px = sh_display_px(); float sc = sh_display_scale();
  if (px.width <= 0) { px = sh_device_screen_px(gDev); sc = sh_device_screen_scale(gDev); }
  m[@"pixelWidth"] = @(px.width); m[@"pixelHeight"] = @(px.height); m[@"scale"] = @(sc);
  m[@"pointWidth"] = @(px.width / sc); m[@"pointHeight"] = @(px.height / sc);
  m[@"ready"] = @(gUp); m[@"streaming"] = @(sh_capture_streaming());
  m[@"helperVersion"] = @SH_VERSION; m[@"pid"] = @(getpid());
  return m;
}

static void teardownAll(void) {
  sh_capture_teardown(); sh_input_teardown(); sh_describe_teardown();
  gUp = NO;
}

static BOOL setupAll(void) {
  NSString *err = nil;
  if (!sh_capture_setup(gDev, &err)) goto fail;
  if (!sh_input_setup(gDev, &err)) { sh_capture_teardown(); goto fail; }
  sh_describe_setup(gDev);
  gUp = YES; gLastSetupErr = nil;
  return YES;
fail:
  if (![err isEqualToString:gLastSetupErr]) {   // report each distinct failure once, keep retrying quietly
    gLastSetupErr = err;
    sh_log(@"setup failed: %@", err);
    sh_event(@"error", @{ @"code": @"setup-failed", @"message": err ?: @"" });
  }
  return NO;
}

static void tick(void) {
  unsigned long long st = sh_device_state(gDev);
  if (st != 3 && gUp) {   // tear down BEFORE announcing, so nothing acts on a dead device after the event
    sh_log(@"device left Booted (%@): tearing down", sh_device_state_name(gDev));
    teardownAll();
  }
  if (st != gLastState) {
    gLastState = st;
    sh_event(@"device-state", @{ @"state": sh_device_state_name(gDev), @"booted": [NSNumber numberWithBool:(st == 3)] });
  }
  if (st == 3 && !gUp && setupAll()) {
    sh_event(@"ready", @{ @"device": infoBody() });
    sh_describe_prewarm();   // capture_setup already re-registered a stream we were running
  }
}

static void finish(int code) {
  dispatch_sync(gInputQ, ^{ if (sh_input_ready()) sh_input_release_touch(); });
  sh_capture_teardown();
  exit(code);
}

static void handle(NSDictionary *req) {
  id rid = req[@"id"];
  NSString *cmd = req[@"cmd"];
  if (![cmd isKindOfClass:NSString.class]) { sh_reply_err(rid, @"bad-request", @"missing 'cmd'"); return; }

  if ([cmd isEqual:@"ping"]) { sh_reply_ok(rid, @{ @"t": @(sh_now_micros()) }); return; }
  if ([cmd isEqual:@"info"]) { sh_reply_ok(rid, @{ @"device": infoBody() }); return; }
  if ([cmd isEqual:@"quit"]) { sh_reply_ok(rid, nil); dispatch_async(gCtlQ, ^{ finish(0); }); return; }

  if ([cmd isEqual:@"stream"]) {
    BOOL on = req[@"on"] ? [req[@"on"] boolValue] : YES;
    int fps = [req[@"maxFps"] isKindOfClass:NSNumber.class] ? [req[@"maxFps"] intValue] : 0;
    double scale = [req[@"scale"] isKindOfClass:NSNumber.class] ? [req[@"scale"] doubleValue] : 0;
    double q = [req[@"quality"] isKindOfClass:NSNumber.class] ? [req[@"quality"] doubleValue] : 0;
    sh_capture_stream(on, fps, scale, q);
    sh_reply_ok(rid, @{ @"streaming": @(on), @"deviceReady": @(gUp) });
    return;
  }

  if ([cmd isEqual:@"screenshot"]) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *fmtS = [req[@"format"] isKindOfClass:NSString.class] ? [req[@"format"] lowercaseString] : @"png";
      int fmt = [fmtS isEqual:@"jpeg"] || [fmtS isEqual:@"jpg"] ? 1 : 2;
      if (![fmtS isEqual:@"png"] && fmt == 2) { sh_reply_err(rid, @"bad-request", @"format must be png|jpeg"); return; }
      double scale = [req[@"scale"] isKindOfClass:NSNumber.class] ? [req[@"scale"] doubleValue] : 1.0;
      double q = [req[@"quality"] isKindOfClass:NSNumber.class] ? [req[@"quality"] doubleValue] : 0.85;
      if (scale <= 0 || scale > 1) scale = 1;
      int w = 0, h = 0; NSString *err = nil;
      NSData *img = sh_capture_screenshot(fmt, scale, q, &w, &h, &err);
      if (!img) { sh_reply_err(rid, gUp ? @"screenshot-failed" : @"not-ready", err); return; }
      uint32_t seq = ++gImageSeq;
      sh_send_image(seq, (uint8_t)fmt, w, h, img);   // type-3 message strictly BEFORE the reply
      sh_reply_ok(rid, @{ @"imageId": @(seq), @"format": fmt == 1 ? @"jpeg" : @"png", @"width": @(w), @"height": @(h), @"bytes": @(img.length) });
    });
    return;
  }

  if ([cmd isEqual:@"describe"] || [cmd isEqual:@"describe-point"]) {
    dispatch_async(gAxQ, ^{
      NSDictionary *r;
      if ([cmd isEqual:@"describe"]) r = sh_describe_all(req[@"flat"] ? [req[@"flat"] boolValue] : YES);
      else {
        if (![req[@"x"] isKindOfClass:NSNumber.class] || ![req[@"y"] isKindOfClass:NSNumber.class]) { sh_reply_err(rid, @"bad-request", @"missing numeric x/y"); return; }
        r = sh_describe_point([req[@"x"] doubleValue], [req[@"y"] doubleValue]);
      }
      NSDictionary *e = r[@"error"];
      if (e) sh_reply_err(rid, e[@"code"], e[@"message"]); else sh_reply_ok(rid, r);
    });
    return;
  }

  static NSSet *inputCmds;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ inputCmds = [NSSet setWithObjects:@"touch", @"tap", @"swipe", @"pinch", @"button", @"key", @"text", nil]; });
  if ([inputCmds containsObject:cmd]) {
    dispatch_async(gInputQ, ^{
      @autoreleasepool {
        NSDictionary *r = sh_input_run(req);
        if (r[@"code"]) sh_reply_err(rid, r[@"code"], r[@"message"]);
        else if (![r[@"_quiet"] boolValue]) sh_reply_ok(rid, r);
      }
    });
    return;
  }
  sh_reply_err(rid, @"unknown-command", [NSString stringWithFormat:@"unknown command '%@'", cmd]);
}

static int cmdAttach(NSString *udid) {
  gUdid = udid.uppercaseString;
  NSString *err = nil;
  if (!sh_load_frameworks(&err)) { sh_event(@"error", @{ @"code": @"no-xcode", @"message": err, @"fatal": @YES }); sh_log(@"%@", err); return 5; }
  int lockFd = sh_take_lock(gUdid, &err);
  if (lockFd < 0) { sh_event(@"error", @{ @"code": @"already-attached", @"message": err, @"fatal": @YES }); sh_log(@"%@", err); return 3; }
  gDev = sh_find_device(gUdid, &err);
  if (!gDev) { sh_event(@"error", @{ @"code": @"device-not-found", @"message": err ?: @"", @"fatal": @YES }); sh_log(@"%@", err); return 4; }

  gCtlQ = dispatch_queue_create("simhelper.ctl", DISPATCH_QUEUE_SERIAL);
  gInputQ = dispatch_queue_create("simhelper.input", DISPATCH_QUEUE_SERIAL);
  gAxQ = dispatch_queue_create("simhelper.ax.req", DISPATCH_QUEUE_SERIAL);

  // The device may be Shutdown/Booting right now: tick() waits for Booted, then sets everything up
  // and emits `ready`. The same path recovers after a shutdown/boot cycle.
  dispatch_async(gCtlQ, ^{ tick(); });
  dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gCtlQ);
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 2), NSEC_PER_SEC / 2, 50 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer, ^{ @autoreleasepool { tick(); } });
  dispatch_resume(timer);

  for (NSNumber *s in @[@SIGTERM, @SIGINT, @SIGHUP]) {
    signal(s.intValue, SIG_IGN);
    dispatch_source_t src = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, s.intValue, 0, gCtlQ);
    dispatch_source_set_event_handler(src, ^{ finish(0); });
    dispatch_resume(src);
    static NSMutableArray *keep; if (!keep) keep = [NSMutableArray array]; [keep addObject:src];
  }

  NSThread *reader = [[NSThread alloc] initWithBlock:^{
    sh_protocol_read_loop(^(NSDictionary *req) { handle(req); });
    sh_log(@"stdin closed; exiting");
    dispatch_async(gCtlQ, ^{ finish(0); });
  }];
  reader.name = @"simhelper.stdin";
  [reader start];
  dispatch_main();
}

int main(int argc, char **argv) {
  @autoreleasepool {
    sh_protocol_init();
    if (argc >= 2 && (!strcmp(argv[1], "--version") || !strcmp(argv[1], "version"))) { printf("sim-helper %s\n", SH_VERSION); return 0; }
    if (argc >= 2 && !strcmp(argv[1], "list")) {
      NSString *err = nil;
      if (!sh_load_frameworks(&err)) { fprintf(stderr, "%s\n", err.UTF8String); return 1; }
      NSArray *devs = sh_list_devices(&err);
      if (!devs) { fprintf(stderr, "%s\n", err.UTF8String); return 1; }
      NSData *d = [NSJSONSerialization dataWithJSONObject:devs options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
      fwrite(d.bytes, 1, d.length, stdout); fputc('\n', stdout);
      return 0;
    }
    if (argc >= 3 && !strcmp(argv[1], "attach")) return cmdAttach(@(argv[2]));
    fprintf(stderr, "usage: sim-helper --version | list | attach <udid>\n");
    return 2;
  }
}
