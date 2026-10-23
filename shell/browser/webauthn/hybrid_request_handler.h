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
// The internal result reports callback delivery, not a JavaScript return value.
// The public handler returns void and cannot supply a credential response, RP,
// origin, challenge or verification flags.
using HybridRequestHandler =
    base::RepeatingCallback<bool(v8::Local<v8::Value>, v8::Local<v8::Value>)>;
}  // namespace electron
#endif
