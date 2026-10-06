// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_WEBAUTHN_HYBRID_REQUEST_STATE_H_
#define ELECTRON_SHELL_BROWSER_WEBAUTHN_HYBRID_REQUEST_STATE_H_

namespace electron {

// The lifetime gate shared by the native delegate and standalone tests. This
// owns no credentials or crypto and cannot complete an authentication request.
class HybridRequestState {
 public:
  bool Configure(bool enabled,
                 bool modal_get,
                 bool virtual_environment,
                 bool has_factory) {
    if (configured_ || closed_ || !enabled || !modal_get ||
        virtual_environment || !has_factory) {
      return false;
    }
    configured_ = true;
    return true;
  }

  bool SetAvailable(bool available) {
    if (!configured_ || closed_ || (notified_ && available_ == available))
      return false;
    notified_ = true;
    available_ = available;
    return true;
  }

  // Claim before invoking the native OnceClosure. That call may synchronously
  // destroy the delegate. Duplicate/stale app callbacks must have no effect.
  bool TakeCancel() {
    if (!configured_ || closed_)
      return false;
    closed_ = true;
    return true;
  }

  void Close() { closed_ = true; }
  bool active() const { return configured_ && !closed_; }

  bool TakeCloseNotification() {
    if (!closed_ || !configured_ || close_notified_)
      return false;
    close_notified_ = true;
    return true;
  }

 private:
  bool configured_ = false;
  bool notified_ = false;
  bool available_ = false;
  bool closed_ = false;
  bool close_notified_ = false;
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_WEBAUTHN_HYBRID_REQUEST_STATE_H_
