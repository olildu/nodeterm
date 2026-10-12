// sim-helper — shared declarations. See PROTOCOL.md for the wire format.
//
// Every call into CoreSimulator / SimulatorKit / AccessibilityPlatformTranslation goes through
// objc_msgSend with an EXACT, non-variadic prototype (arm64 passes variadic args on the stack and
// a variadic cast crashes in objc_retain), and is wrapped in SH_TRY because those frameworks throw
// ObjC exceptions when the device goes away underneath them.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOSurface/IOSurface.h>
#import <objc/runtime.h>
#import <objc/message.h>

#define SH_VERSION "0.1.0"

// ObjC runtime sugar -------------------------------------------------------------------------
#define SH_SEL(s) sel_registerName(s)
#define SH_GET(T, o, s) ((T (*)(id, SEL))objc_msgSend)((o), SH_SEL(s))  // no-arg getters only

/// Runs `body` and converts an ObjC exception into a message in `*err` (returns NO).
BOOL sh_try(NSString **err, void (^body)(void));

// log (stderr only) --------------------------------------------------------------------------
void sh_log(NSString *fmt, ...) NS_FORMAT_FUNCTION(1, 2);
uint64_t sh_now_micros(void);
double sh_now_ms(void);

// protocol.m ---------------------------------------------------------------------------------
void sh_protocol_init(void);
void sh_send_json(NSDictionary *obj);                                  // type 2
void sh_send_video_frame(uint64_t captureMicros, int w, int h, NSData *jpeg);  // type 1
void sh_send_image(uint32_t reqId, uint8_t fmt, int w, int h, NSData *img);    // type 3
void sh_event(NSString *name, NSDictionary *extra);
void sh_reply_ok(id reqId, NSDictionary *extra);
void sh_reply_err(id reqId, NSString *code, NSString *message);
/// Reads stdin lines forever (blocking, call from a dedicated thread). Returns at EOF.
void sh_protocol_read_loop(void (^onRequest)(NSDictionary *req));

// device.m -----------------------------------------------------------------------------------
NSString *sh_developer_dir(void);
BOOL sh_load_frameworks(NSString **err);
id sh_find_device(NSString *udid, NSString **err);   // SimDevice or nil
NSArray<NSDictionary *> *sh_list_devices(NSString **err);
NSDictionary *sh_device_summary(id dev);              // udid,name,runtime,state,...
unsigned long long sh_device_state(id dev);           // 3 = Booted
NSString *sh_device_state_name(id dev);
CGSize sh_device_screen_px(id dev);                   // deviceType.mainScreenSize
float sh_device_screen_scale(id dev);
/// Exclusive per-UDID flock. Returns the fd (keep open), or -1 with *err set.
int sh_take_lock(NSString *udid, NSString **err);
/// Current display state shared by capture/input/describe (pixels + scale); updated on surface changes.
CGSize sh_display_px(void);
float sh_display_scale(void);
void sh_set_display_px(CGSize px, float scale);

// capture.m ----------------------------------------------------------------------------------
BOOL sh_capture_setup(id dev, NSString **err);
void sh_capture_teardown(void);
/// stream on/off/reconfigure. Params are clamped. Safe to call from any queue.
void sh_capture_stream(BOOL on, int maxFps, double scale, double quality);
BOOL sh_capture_streaming(void);
/// One still. fmt: 1 = JPEG, 2 = PNG. Returns nil with *err on failure.
NSData *sh_capture_screenshot(int fmt, double scale, double quality, int *w, int *h, NSString **err);

// input.m ------------------------------------------------------------------------------------
BOOL sh_input_setup(id dev, NSString **err);
void sh_input_teardown(void);
BOOL sh_input_ready(void);
/// Executes one input command (touch/tap/swipe/pinch/button/key/text). Blocks until the device acked
/// every message. Returns nil on success or an error dictionary {code,message}.
NSDictionary *sh_input_run(NSDictionary *req);
/// Releases a held touch (EOF / shutdown safety).
void sh_input_release_touch(void);

// describe.m ---------------------------------------------------------------------------------
void sh_describe_setup(id dev);
void sh_describe_teardown(void);
/// {elements:[...]} / {element:{...}|null} reply bodies or an error dictionary {code,message} (key "error").
NSDictionary *sh_describe_all(BOOL flat);
NSDictionary *sh_describe_point(double x, double y);
void sh_describe_prewarm(void);
