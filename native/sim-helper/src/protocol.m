// Wire framing on stdout and the request reader on stdin. See PROTOCOL.md.
#import "sh.h"
#include <pthread.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <stdarg.h>

static pthread_mutex_t gOutLock = PTHREAD_MUTEX_INITIALIZER;

uint64_t sh_now_micros(void) {
  struct timespec t; clock_gettime(CLOCK_REALTIME, &t);
  return (uint64_t)t.tv_sec * 1000000ull + (uint64_t)t.tv_nsec / 1000;
}
double sh_now_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}

void sh_log(NSString *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  NSString *s = [[NSString alloc] initWithFormat:fmt arguments:ap];
  va_end(ap);
  fprintf(stderr, "[sim-helper] %s\n", s.UTF8String);
}

BOOL sh_try(NSString **err, void (^body)(void)) {
  @try { body(); return YES; }
  @catch (NSException *e) {
    if (err) *err = [NSString stringWithFormat:@"%@: %@", e.name, e.reason];
    sh_log(@"exception: %@: %@", e.name, e.reason);
    return NO;
  }
}

void sh_protocol_init(void) {
  // A closed stdout means the parent is gone; we exit instead of dying on SIGPIPE mid-write.
  signal(SIGPIPE, SIG_IGN);
}

static void writeAll(const uint8_t *p, size_t n) {
  while (n > 0) {
    ssize_t w = write(STDOUT_FILENO, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      _exit(0);  // parent closed the pipe
    }
    p += w; n -= (size_t)w;
  }
}

static void writeMessage(uint8_t type, const uint8_t *head, size_t headLen, const uint8_t *body, size_t bodyLen) {
  uint32_t len = (uint32_t)(1 + headLen + bodyLen);
  uint8_t pre[5] = { (uint8_t)(len >> 24), (uint8_t)(len >> 16), (uint8_t)(len >> 8), (uint8_t)len, type };
  pthread_mutex_lock(&gOutLock);
  writeAll(pre, 5);
  if (headLen) writeAll(head, headLen);
  if (bodyLen) writeAll(body, bodyLen);
  pthread_mutex_unlock(&gOutLock);
}

void sh_send_video_frame(uint64_t captureMicros, int w, int h, NSData *jpeg) {
  uint8_t head[12];
  for (int i = 0; i < 8; i++) head[i] = (uint8_t)(captureMicros >> (56 - 8 * i));
  head[8] = (uint8_t)(w >> 8); head[9] = (uint8_t)w; head[10] = (uint8_t)(h >> 8); head[11] = (uint8_t)h;
  writeMessage(1, head, sizeof head, jpeg.bytes, jpeg.length);
}

void sh_send_image(uint32_t reqId, uint8_t fmt, int w, int h, NSData *img) {
  uint8_t head[9] = { (uint8_t)(reqId >> 24), (uint8_t)(reqId >> 16), (uint8_t)(reqId >> 8), (uint8_t)reqId,
                      fmt, (uint8_t)(w >> 8), (uint8_t)w, (uint8_t)(h >> 8), (uint8_t)h };
  writeMessage(3, head, sizeof head, img.bytes, img.length);
}

// JSON may not carry NaN/Inf; replace them rather than dropping the whole reply.
static id sanitize(id v) {
  if ([v isKindOfClass:NSNumber.class]) {
    double d = [v doubleValue];
    if (isnan(d) || isinf(d)) return @0;
    return v;
  }
  if ([v isKindOfClass:NSDictionary.class]) {
    NSMutableDictionary *o = [NSMutableDictionary dictionaryWithCapacity:[v count]];
    [v enumerateKeysAndObjectsUsingBlock:^(id k, id x, BOOL *s) { o[k] = sanitize(x); }];
    return o;
  }
  if ([v isKindOfClass:NSArray.class]) {
    NSMutableArray *o = [NSMutableArray arrayWithCapacity:[v count]];
    for (id x in v) [o addObject:sanitize(x)];
    return o;
  }
  if ([v isKindOfClass:NSString.class] || [v isKindOfClass:NSNull.class]) return v;
  return [v description];
}

void sh_send_json(NSDictionary *obj) {
  NSError *e = nil;
  NSData *d = [NSJSONSerialization dataWithJSONObject:sanitize(obj) options:0 error:&e];
  if (!d) {
    d = [NSJSONSerialization dataWithJSONObject:@{ @"event": @"error", @"code": @"encode-failed", @"message": e.description ?: @"" } options:0 error:nil];
  }
  writeMessage(2, NULL, 0, d.bytes, d.length);
}

void sh_event(NSString *name, NSDictionary *extra) {
  NSMutableDictionary *m = [NSMutableDictionary dictionaryWithObject:name forKey:@"event"];
  if (extra) [m addEntriesFromDictionary:extra];
  sh_send_json(m);
}

void sh_reply_ok(id reqId, NSDictionary *extra) {
  NSMutableDictionary *m = [NSMutableDictionary dictionary];
  if (reqId) m[@"id"] = reqId;
  m[@"ok"] = @YES;
  if (extra) [m addEntriesFromDictionary:extra];
  sh_send_json(m);
}

void sh_reply_err(id reqId, NSString *code, NSString *message) {
  NSMutableDictionary *m = [NSMutableDictionary dictionary];
  if (reqId) m[@"id"] = reqId;
  m[@"ok"] = @NO; m[@"code"] = code ?: @"error"; m[@"error"] = message ?: code ?: @"error";
  sh_send_json(m);
}

void sh_protocol_read_loop(void (^onRequest)(NSDictionary *req)) {
  char *line = NULL; size_t cap = 0; ssize_t n;
  while ((n = getline(&line, &cap, stdin)) >= 0) {
    @autoreleasepool {
      NSData *d = [NSData dataWithBytesNoCopy:line length:(NSUInteger)n freeWhenDone:NO];
      NSString *trim = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
      trim = [trim stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if (trim.length == 0) continue;
      NSError *e = nil;
      id obj = [NSJSONSerialization JSONObjectWithData:[trim dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&e];
      if (![obj isKindOfClass:NSDictionary.class]) {
        sh_reply_err(nil, @"bad-request", @"request is not a JSON object");
        continue;
      }
      onRequest(obj);
    }
  }
  free(line);
}
