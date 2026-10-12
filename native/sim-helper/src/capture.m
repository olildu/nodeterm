// Screen capture: SimScreen frameCallback -> framebuffer IOSurface -> JPEG (CoreImage, GPU).
// Frames coalesce (the encoder always encodes the NEWEST surface contents, never a backlog) and a
// frame byte-identical to the last one sent is dropped, so a static screen costs nothing on the wire.
#import "sh.h"
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>

static id gScreen;                 // SimScreen descriptor (ROCK proxy — no KVC)
static IOSurfaceRef gSurface;      // newest framebuffer surface
static NSUUID *gUUID;
static BOOL gRegistered;
static uint64_t gGen;              // bumps on every (re)setup/teardown; stale callbacks compare against it
static dispatch_queue_t gCbQ, gEncQ;
static CIContext *gCI;

// stream config (touched only on gCbQ except where noted)
static BOOL gWant;                 // client asked for a stream (survives device recovery)
static int gMaxFps = 30; static double gScale = 0.5, gQuality = 0.7;
static BOOL gPending, gEncoding;
static uint64_t gLastEmitUs, gLastFrameUs;
static NSData *gLastJpeg;

static void queuesInit(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    gCbQ = dispatch_queue_create("simhelper.capture.cb", DISPATCH_QUEUE_SERIAL);
    gEncQ = dispatch_queue_create("simhelper.capture.enc", DISPATCH_QUEUE_SERIAL);
    gCI = [CIContext contextWithOptions:@{ kCIContextUseSoftwareRenderer: @NO, kCIContextCacheIntermediates: @NO }];
  });
}

static id findScreenOnDevice(id dev, NSString **err) {
  __block id found = nil;
  sh_try(err, ^{
    id io = SH_GET(id, dev, "io");
    for (id port in SH_GET(id, io, "ioPorts")) {
      id desc = SH_GET(id, port, "descriptor");
      if (!desc) continue;
      if (![desc respondsToSelector:SH_SEL("framebufferSurface")]) continue;
      CGSize sz = SH_GET(CGSize, desc, "displaySize");
      if (sz.width > 0 && sz.height > 0) { found = desc; break; }
    }
  });
  if (!found && err && !*err) *err = @"no framebuffer display port with a non-zero size (device still booting?)";
  return found;
}

static NSData *encode(IOSurfaceRef surf, int fmt, double scale, double quality, int *ow, int *oh) {
  CIImage *img = [CIImage imageWithIOSurface:surf];
  if (!img) return nil;
  if (scale != 1.0) img = [img imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
  *ow = (int)img.extent.size.width; *oh = (int)img.extent.size.height;
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  NSData *d;
  if (fmt == 2) d = [gCI PNGRepresentationOfImage:img format:kCIFormatBGRA8 colorSpace:cs options:@{}];
  else d = [gCI JPEGRepresentationOfImage:img colorSpace:cs options:@{ (id)kCGImageDestinationLossyCompressionQuality: @(quality) }];
  CGColorSpaceRelease(cs);
  return d;
}

static void kick(uint64_t gen);
static void kick(uint64_t gen) {
  dispatch_async(gCbQ, ^{
    if (gen != gGen || !gWant || !gPending || gEncoding || !gSurface) return;
    uint64_t now = sh_now_micros();
    uint64_t gap = 1000000ull / (uint64_t)gMaxFps;
    if (now - gLastEmitUs < gap) {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(gap - (now - gLastEmitUs)) * 1000), gCbQ, ^{ kick(gen); });
      return;
    }
    gPending = NO; gEncoding = YES; gLastEmitUs = now;
    IOSurfaceRef surf = (IOSurfaceRef)CFRetain(gSurface);
    uint64_t capUs = gLastFrameUs ?: now;
    double scale = gScale, q = gQuality;
    dispatch_async(gEncQ, ^{
      @autoreleasepool {
        int w = 0, h = 0;
        NSData *jpg = nil;
        @try { jpg = encode(surf, 1, scale, q, &w, &h); } @catch (NSException *e) { sh_log(@"encode exception: %@", e); }
        CFRelease(surf);
        dispatch_async(gCbQ, ^{
          gEncoding = NO;
          if (gen == gGen && gWant && jpg && ![jpg isEqualToData:gLastJpeg]) {
            gLastJpeg = jpg;
            sh_send_video_frame(capUs, w, h, jpg);
          }
          kick(gen);
        });
      }
    });
  });
}

static void registerCallbacks(void) {  // on gCbQ
  if (gRegistered || !gScreen) return;
  uint64_t gen = gGen;
  void (^frameCb)(void) = ^{ gLastFrameUs = sh_now_micros(); gPending = YES; kick(gen); };
  void (^surfCb)(IOSurface *, IOSurface *) = ^(IOSurface *fb, IOSurface *masked) {
    if (!fb || gen != gGen) return;
    IOSurfaceRef old = gSurface;
    gSurface = (IOSurfaceRef)CFBridgingRetain(fb);
    if (old) CFRelease(old);
    CGSize px = CGSizeMake((CGFloat)IOSurfaceGetWidth(gSurface), (CGFloat)IOSurfaceGetHeight(gSurface));
    CGSize prev = sh_display_px();
    if (px.width != prev.width || px.height != prev.height) {
      sh_set_display_px(px, 0);
      float sc = sh_display_scale();
      sh_event(@"surfaces-changed", @{ @"pixelWidth": @(px.width), @"pixelHeight": @(px.height),
                                       @"pointWidth": @(px.width / sc), @"pointHeight": @(px.height / sc), @"scale": @(sc) });
    }
    gLastJpeg = nil;
    gPending = YES; kick(gen);
  };
  void (^propCb)(id) = ^(id props) {};
  gUUID = [NSUUID UUID];
  NSString *err = nil;
  BOOL ok = sh_try(&err, ^{
    ((void (*)(id, SEL, id, id, id, id, id))objc_msgSend)(gScreen,
        SH_SEL("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"),
        gUUID, gCbQ, frameCb, surfCb, propCb);
  });
  if (ok) gRegistered = YES;
  else sh_event(@"error", @{ @"code": @"stream-failed", @"message": err ?: @"registerScreenCallbacks failed" });
  gLastJpeg = nil; gPending = YES; kick(gen);  // one frame right away so a consumer has something to show
}

static void unregisterCallbacks(void) {  // on gCbQ
  if (!gRegistered) return;
  gRegistered = NO;
  NSUUID *u = gUUID;
  sh_try(NULL, ^{ ((void (*)(id, SEL, id))objc_msgSend)(gScreen, SH_SEL("unregisterScreenCallbacksWithUUID:"), u); });
}

BOOL sh_capture_setup(id dev, NSString **err) {
  queuesInit();
  id screen = findScreenOnDevice(dev, err);
  if (!screen) return NO;
  __block IOSurfaceRef surf = NULL;
  if (!sh_try(err, ^{ id s = SH_GET(id, screen, "framebufferSurface"); if (s) surf = (IOSurfaceRef)CFBridgingRetain(s); }) || !surf) {
    if (err && !*err) *err = @"framebufferSurface unavailable";
    return NO;
  }
  dispatch_sync(gCbQ, ^{
    gGen++;
    gScreen = screen;
    if (gSurface) CFRelease(gSurface);
    gSurface = surf;
    gRegistered = NO; gPending = NO; gEncoding = NO; gLastJpeg = nil;
  });
  float sc = sh_device_screen_scale(dev);
  sh_set_display_px(CGSizeMake((CGFloat)IOSurfaceGetWidth(surf), (CGFloat)IOSurfaceGetHeight(surf)), sc);
  dispatch_async(gCbQ, ^{ if (gWant) registerCallbacks(); });
  return YES;
}

void sh_capture_teardown(void) {
  if (!gCbQ) return;
  dispatch_sync(gCbQ, ^{
    unregisterCallbacks();
    gGen++;
    gScreen = nil;
    if (gSurface) { CFRelease(gSurface); gSurface = NULL; }
    gPending = NO;
  });
}

void sh_capture_stream(BOOL on, int maxFps, double scale, double quality) {
  queuesInit();
  dispatch_async(gCbQ, ^{
    if (maxFps > 0) gMaxFps = maxFps > 120 ? 120 : maxFps;
    if (scale > 0) gScale = scale < 0.05 ? 0.05 : (scale > 1 ? 1 : scale);
    if (quality > 0) gQuality = quality < 0.05 ? 0.05 : (quality > 1 ? 1 : quality);
    BOOL was = gWant;
    gWant = on;
    if (!on) { unregisterCallbacks(); gLastJpeg = nil; return; }
    if (!gScreen) return;                 // device down: resumes automatically after recovery
    if (!was || !gRegistered) registerCallbacks();
    else { gLastJpeg = nil; gPending = YES; kick(gGen); }  // reconfigure: push a fresh frame in the new format
  });
}

BOOL sh_capture_streaming(void) { __block BOOL w = NO; if (gCbQ) dispatch_sync(gCbQ, ^{ w = gWant; }); return w; }

NSData *sh_capture_screenshot(int fmt, double scale, double quality, int *w, int *h, NSString **err) {
  queuesInit();
  __block id screen = nil;
  dispatch_sync(gCbQ, ^{ screen = gScreen; });
  if (!screen) { if (err) *err = @"no screen (device not booted)"; return nil; }
  __block NSData *out = nil;
  dispatch_sync(gEncQ, ^{
    @autoreleasepool {
      sh_try(err, ^{
        id s = SH_GET(id, screen, "framebufferSurface");   // fresh: independent of the stream's cached surface
        if (!s) { if (err) *err = @"framebufferSurface unavailable"; return; }
        out = encode((__bridge IOSurfaceRef)s, fmt, scale > 0 ? scale : 1.0, quality > 0 ? quality : 0.85, w, h);
      });
    }
  });
  if (!out && err && !*err) *err = @"encode failed";
  return out;
}
