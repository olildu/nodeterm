// Framework loading, device lookup/listing, per-UDID lock, shared display geometry.
#import "sh.h"
#include <dlfcn.h>
#include <pthread.h>
#include <errno.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>

static NSString *gDevDir;
static CGSize gDisplayPx; static float gDisplayScale = 1;
static pthread_mutex_t gDispLock = PTHREAD_MUTEX_INITIALIZER;

NSString *sh_developer_dir(void) {
  if (gDevDir) return gDevDir;
  const char *env = getenv("DEVELOPER_DIR");
  if (env && *env) return gDevDir = @(env);
  // Never hardcode /Applications/Xcode.app — people keep Xcode-beta or renamed copies.
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
  t.arguments = @[@"-p"];
  NSPipe *p = [NSPipe pipe]; t.standardOutput = p; t.standardError = [NSFileHandle fileHandleWithNullDevice];
  NSString *out = nil;
  @try {
    [t launchAndReturnError:nil];
    NSData *d = [p.fileHandleForReading readDataToEndOfFile];
    [t waitUntilExit];
    if (t.terminationStatus == 0) out = [[[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  } @catch (NSException *e) {}
  gDevDir = out.length ? out : @"/Applications/Xcode.app/Contents/Developer";
  return gDevDir;
}

BOOL sh_load_frameworks(NSString **err) {
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) {
    if (err) *err = [NSString stringWithFormat:@"cannot load CoreSimulator: %s (is Xcode installed?)", dlerror()];
    return NO;
  }
  NSString *sk = [sh_developer_dir() stringByAppendingString:@"/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
  if (!dlopen(sk.UTF8String, RTLD_NOW)) {
    if (err) *err = [NSString stringWithFormat:@"cannot load SimulatorKit from %@: %s", sk, dlerror()];
    return NO;
  }
  // AX translation is optional: only `describe` needs it.
  dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation", RTLD_NOW);
  return YES;
}

static id deviceSet(NSString **err) {
  __block id set = nil;
  NSString *msg = nil;
  sh_try(&msg, ^{
    NSError *e = nil;
    id ctx = ((id (*)(id, SEL, id, NSError **))objc_msgSend)((id)objc_getClass("SimServiceContext"),
        SH_SEL("sharedServiceContextForDeveloperDir:error:"), sh_developer_dir(), &e);
    if (!ctx) { if (err) *err = [NSString stringWithFormat:@"SimServiceContext: %@", e]; return; }
    set = ((id (*)(id, SEL, NSError **))objc_msgSend)(ctx, SH_SEL("defaultDeviceSetWithError:"), &e);
    if (!set && err) *err = [NSString stringWithFormat:@"defaultDeviceSet: %@", e];
  });
  if (!set && err && !*err) *err = msg ?: @"no device set";
  return set;
}

id sh_find_device(NSString *udid, NSString **err) {
  id set = deviceSet(err);
  if (!set) return nil;
  __block id found = nil;
  sh_try(err, ^{
    for (id d in SH_GET(id, set, "devices"))
      if ([[SH_GET(id, d, "UDID") UUIDString] caseInsensitiveCompare:udid] == NSOrderedSame) { found = d; break; }
  });
  if (!found && err && !*err) *err = [NSString stringWithFormat:@"device %@ not found", udid];
  return found;
}

unsigned long long sh_device_state(id dev) {
  __block unsigned long long s = 0;
  sh_try(NULL, ^{ s = SH_GET(unsigned long long, dev, "state"); });
  return s;
}
NSString *sh_device_state_name(id dev) {
  switch (sh_device_state(dev)) {
    case 0: return @"Creating"; case 1: return @"Shutdown"; case 2: return @"Booting";
    case 3: return @"Booted"; case 4: return @"Shutting Down"; default: return @"Unknown";
  }
}

CGSize sh_device_screen_px(id dev) {
  __block CGSize s = CGSizeZero;
  sh_try(NULL, ^{ s = SH_GET(CGSize, SH_GET(id, dev, "deviceType"), "mainScreenSize"); });
  return s;
}
float sh_device_screen_scale(id dev) {
  __block float s = 1;
  sh_try(NULL, ^{ s = SH_GET(float, SH_GET(id, dev, "deviceType"), "mainScreenScale"); });
  return s > 0 ? s : 1;
}

NSDictionary *sh_device_summary(id dev) {
  NSMutableDictionary *m = [NSMutableDictionary dictionary];
  sh_try(NULL, ^{
    m[@"udid"] = [SH_GET(id, dev, "UDID") UUIDString] ?: @"";
    m[@"name"] = SH_GET(id, dev, "name") ?: @"";
    m[@"state"] = sh_device_state_name(dev);
    id rt = SH_GET(id, dev, "runtime");
    NSString *rn = rt ? SH_GET(id, rt, "name") : nil;
    m[@"runtime"] = rn ?: @"";
    id dt = SH_GET(id, dev, "deviceType");
    NSString *dn = dt ? SH_GET(id, dt, "identifier") : nil;
    if (dn) m[@"deviceType"] = dn;
    if ([dev respondsToSelector:SH_SEL("isAvailable")]) m[@"available"] = @(SH_GET(BOOL, dev, "isAvailable"));
  });
  return m;
}

NSArray<NSDictionary *> *sh_list_devices(NSString **err) {
  id set = deviceSet(err);
  if (!set) return nil;
  NSMutableArray *out = [NSMutableArray array];
  sh_try(err, ^{ for (id d in SH_GET(id, set, "devices")) [out addObject:sh_device_summary(d)]; });
  return out;
}

int sh_take_lock(NSString *udid, NSString **err) {
  NSString *tmp = NSTemporaryDirectory();
  NSString *path = [tmp stringByAppendingPathComponent:[NSString stringWithFormat:@"nodeterm-sim-helper-%@.lock", udid.uppercaseString]];
  int fd = open(path.UTF8String, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
  if (fd < 0) { if (err) *err = [NSString stringWithFormat:@"cannot open lock file %@: %s", path, strerror(errno)]; return -1; }
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    if (err) *err = [NSString stringWithFormat:@"another sim-helper already controls device %@ (lock %@)", udid, path];
    close(fd); return -1;
  }
  // Informational only; the flock is the lock.
  ftruncate(fd, 0);
  NSString *pid = [NSString stringWithFormat:@"%d\n", getpid()];
  write(fd, pid.UTF8String, pid.length);
  return fd;
}

CGSize sh_display_px(void) { pthread_mutex_lock(&gDispLock); CGSize s = gDisplayPx; pthread_mutex_unlock(&gDispLock); return s; }
float sh_display_scale(void) { pthread_mutex_lock(&gDispLock); float s = gDisplayScale; pthread_mutex_unlock(&gDispLock); return s; }
void sh_set_display_px(CGSize px, float scale) {
  pthread_mutex_lock(&gDispLock); gDisplayPx = px; if (scale > 0) gDisplayScale = scale; pthread_mutex_unlock(&gDispLock);
}
