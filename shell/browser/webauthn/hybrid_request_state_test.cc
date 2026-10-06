// Standalone lifetime-policy test, usable without a Chromium checkout.
#include <cstdlib>
#include <iostream>

#include "shell/browser/webauthn/hybrid_request_state.h"

namespace {
void Expect(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
  }
}

}  // namespace

int main() {
  using electron::HybridRequestState;
  for (int disabled_gate = 0; disabled_gate < 4; ++disabled_gate) {
    HybridRequestState state;
    Expect(!state.Configure(disabled_gate != 0, disabled_gate != 1,
                            disabled_gate == 2, disabled_gate != 3),
           "default-off/non-modal/test/null factory must not configure");
    Expect(!state.SetAvailable(true), "ineligible requests have no UI");
    Expect(!state.TakeCancel(), "ineligible request cannot cancel other transports");
  }
  HybridRequestState cancelled_before_ui;
  Expect(cancelled_before_ui.Configure(true, true, false, true), "eligible request");
  Expect(cancelled_before_ui.TakeCancel(), "cancel before UI");
  Expect(!cancelled_before_ui.SetAvailable(true), "no late UI after cancellation");
  Expect(cancelled_before_ui.TakeCloseNotification(), "release configured owner");

  HybridRequestState shown;
  Expect(shown.Configure(true, true, false, true), "configure");
  Expect(!shown.Configure(true, true, false, true), "no key regeneration in same delegate");
  Expect(shown.SetAvailable(true), "show once");
  Expect(!shown.SetAvailable(true), "no duplicate UI");
  Expect(shown.TakeCancel(), "synchronous app cancel claims request");
  Expect(!shown.active(), "closed before entering native callback");
  Expect(!shown.TakeCancel(), "duplicate cancel ignored");
  shown.Close();
  Expect(shown.TakeCloseNotification(), "notify UI on teardown");
  Expect(!shown.TakeCloseNotification(), "close event once");
  Expect(!shown.Configure(true, true, false, true), "no stale request reuse");

  HybridRequestState unavailable;
  Expect(unavailable.Configure(true, true, false, true), "owned request");
  Expect(unavailable.SetAvailable(false), "initial unavailability is observable");
  Expect(unavailable.active(), "BLE off does not close native request");
  Expect(!unavailable.TakeCloseNotification(), "unavailability is not completion");
  Expect(unavailable.SetAvailable(true), "BLE recovery remains same ceremony");
  Expect(unavailable.SetAvailable(false), "BLE loss updates live owner");
  Expect(unavailable.TakeCancel(), "explicit cancellation still works while unavailable");
  Expect(!unavailable.TakeCancel(), "cancel only once");
  Expect(unavailable.TakeCloseNotification(), "terminal cleanup once");

  HybridRequestState completed;
  Expect(completed.Configure(true, true, false, true), "new request independent");
  Expect(completed.SetAvailable(true), "show next request");
  completed.Close();  // Native success, page abort, timeout, or frame teardown.
  Expect(!completed.TakeCancel(), "late cancellation cannot affect completed request");
  Expect(completed.TakeCloseNotification(), "all native terminal paths close UI");
  std::cout << "PASS: eligibility, reentrancy gate, one-shot cancel, teardown, stale handles\n";
}
