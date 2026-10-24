// SPDX-License-Identifier: GPL-2.0-or-later
// Project bridge, 2026-10-20. Upstream source plus short-offline.patch; see NOTICE.txt.
#include "rubberband/RubberBandStretcher.h"
#include <emscripten.h>
#include <cstdlib>
#include <algorithm>
using RB = RubberBand::RubberBandStretcher;
extern "C" {
EMSCRIPTEN_KEEPALIVE void *rb_alloc(unsigned n) { return std::malloc(n); }
EMSCRIPTEN_KEEPALIVE void rb_free(void *p) { std::free(p); }
EMSCRIPTEN_KEEPALIVE RB *rb_create(unsigned sr, double ratio, int options) {
    return new RB(sr, 1, options, ratio, 1.0);
}
EMSCRIPTEN_KEEPALIVE int rb_engine(RB *s) { return s->getEngineVersion(); }
EMSCRIPTEN_KEEPALIVE void rb_destroy(RB *s) { delete s; }
// Offline mode compensates its own start pad/delay. Feed EVERY input sample
// twice, mark both final blocks, drain after every process call including final.
EMSCRIPTEN_KEEPALIVE int rb_run(RB *s, const float *in, unsigned n, float *out, unsigned capacity) {
    constexpr unsigned block = 1024;
    s->setExpectedInputDuration(n);
    s->setMaxProcessSize(block);
    for (unsigned pos = 0; pos < n; pos += block) {
        unsigned count = std::min(block, n - pos);
        const float *p = in + pos;
        s->study(&p, count, pos + count == n);
    }
    unsigned written = 0;
    for (unsigned pos = 0; pos < n; pos += block) {
        unsigned count = std::min(block, n - pos);
        const float *p = in + pos;
        s->process(&p, count, pos + count == n);
        int available;
        while ((available = s->available()) > 0) {
            if (unsigned(available) > capacity - written) return -1;
            float *dest = out + written;
            unsigned got = s->retrieve(&dest, available);
            if (!got) return -2;
            written += got;
        }
    }
    if (s->available() != -1) return -3;
    return int(written);
}
}
