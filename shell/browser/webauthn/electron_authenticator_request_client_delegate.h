// Copyright (c) 2026 Anthropic, PBC.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_WEBAUTHN_ELECTRON_AUTHENTICATOR_REQUEST_CLIENT_DELEGATE_H_
#define ELECTRON_SHELL_BROWSER_WEBAUTHN_ELECTRON_AUTHENTICATOR_REQUEST_CLIENT_DELEGATE_H_

#include <string>
#include <vector>

#include "base/dcheck_is_on.h"
#include "base/memory/weak_ptr.h"
#include "build/build_config.h"
#include "base/scoped_observation.h"
#include "content/public/browser/authenticator_request_client_delegate.h"
#include "content/public/browser/global_routing_id.h"
#include "shell/browser/webauthn/hybrid_request_state.h"
#include "shell/browser/webauthn/hybrid_request_handler.h"

namespace content {
class RenderFrameHost;
class StoragePartitionConfig;
}

namespace network::mojom {
class NetworkContext;
}

namespace gin {
class Arguments;
}

namespace electron {

class ElectronBrowserContext;

class ElectronAuthenticatorRequestClientDelegate
    : public content::AuthenticatorRequestClientDelegate {
 public:
  explicit ElectronAuthenticatorRequestClientDelegate(
      content::RenderFrameHost* render_frame_host);
  ~ElectronAuthenticatorRequestClientDelegate() override;

  // disable copy
  ElectronAuthenticatorRequestClientDelegate(
      const ElectronAuthenticatorRequestClientDelegate&) = delete;
  ElectronAuthenticatorRequestClientDelegate& operator=(
      const ElectronAuthenticatorRequestClientDelegate&) = delete;

#if DCHECK_IS_ON() && BUILDFLAG(IS_LINUX)
  // Test-only access to the exact resolver used by native caBLE discovery.
  static network::mojom::NetworkContext* ResolveHybridNetworkContextForTesting(
      base::WeakPtr<ElectronBrowserContext> browser_context,
      const content::StoragePartitionConfig& config);
#endif

  // content::AuthenticatorRequestClientDelegate:
  void SetUIPresentation(UIPresentation presentation) override;
  void ConfigureDiscoveries(
      const url::Origin& origin,
      const std::string& rp_id,
      RequestSource request_source,
      device::FidoRequestType request_type,
      std::optional<device::ResidentKeyRequirement> resident_key_requirement,
      device::UserVerificationRequirement user_verification_requirement,
      std::optional<std::string_view> user_name,
      bool is_enclave_authenticator_available,
      device::FidoDiscoveryFactory* discovery_factory) override;
  void OnTransportAvailabilityEnumerated(
      device::FidoRequestHandlerBase::TransportAvailabilityInfo data) override;
  void BluetoothAdapterStatusChanged(
      device::FidoRequestHandlerBase::BleStatus status) override;
  void SetRelyingPartyId(const std::string& rp_id) override;
  void StartObserving(device::FidoRequestHandlerBase* request_handler) override;
  void StopObserving(device::FidoRequestHandlerBase* request_handler) override;
  void RegisterActionCallbacks(
      base::OnceClosure cancel_callback,
      base::OnceClosure immediate_not_found_callback,
      base::RepeatingClosure start_over_callback,
      AccountPreselectedCallback account_preselected_callback,
      PasswordSelectedCallback password_selected_callback,
      device::FidoRequestHandlerBase::RequestCallback request_callback,
      base::OnceClosure cancel_ui_timeout_callback,
      base::RepeatingClosure bluetooth_adapter_power_on_callback,
      base::RepeatingCallback<
          void(device::FidoRequestHandlerBase::BlePermissionCallback)>
          request_ble_permission_callback) override;
  void SelectAccount(
      std::vector<device::AuthenticatorGetAssertionResponse> responses,
      base::OnceCallback<void(device::AuthenticatorGetAssertionResponse)>
          callback) override;

 private:
  void EmitHybridRequest(bool available);
  void CancelHybridRequest();
  void FinishHybridRequest();

  UIPresentation presentation_ = UIPresentation::kDisabled;
  HybridRequestState hybrid_state_;
  HybridRequestHandler hybrid_handler_;
  bool hybrid_transport_present_ = false;
  std::string hybrid_request_id_;
  std::string hybrid_origin_;
  std::string hybrid_qr_;
  base::WeakPtr<ElectronBrowserContext> hybrid_browser_context_;

  void OnAccountSelected(gin::Arguments* args);
  void CancelPendingAccountSelection();

  const content::GlobalRenderFrameHostId render_frame_host_id_;
  std::string relying_party_id_;
  base::OnceClosure cancel_callback_;

  base::ScopedObservation<device::FidoRequestHandlerBase,
                          device::FidoRequestHandlerBase::Observer>
      request_handler_observation_{this};

  std::vector<device::AuthenticatorGetAssertionResponse> pending_responses_;
  base::OnceCallback<void(device::AuthenticatorGetAssertionResponse)>
      select_account_callback_;

  base::WeakPtrFactory<ElectronAuthenticatorRequestClientDelegate>
      weak_factory_{this};
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_WEBAUTHN_ELECTRON_AUTHENTICATOR_REQUEST_CLIENT_DELEGATE_H_
