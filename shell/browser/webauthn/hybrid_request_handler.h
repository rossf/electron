// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

// Experimental trusted main-process UI ownership for native hybrid requests.
#ifndef ELECTRON_SHELL_BROWSER_WEBAUTHN_HYBRID_REQUEST_HANDLER_H_
#define ELECTRON_SHELL_BROWSER_WEBAUTHN_HYBRID_REQUEST_HANDLER_H_
#include "base/functional/callback.h"
#include "v8/include/v8-forward.h"
namespace electron {
// Snapshot before request setup, invoke only after native callbacks exist.
// Return true to acknowledge ready/unavailable updates. No authentication
// response, RP, origin, challenge or verification flags can be returned here.
using HybridRequestHandler =
    base::RepeatingCallback<v8::Local<v8::Value>(v8::Local<v8::Value>,
                                                 v8::Local<v8::Value>)>;
}  // namespace electron
#endif
