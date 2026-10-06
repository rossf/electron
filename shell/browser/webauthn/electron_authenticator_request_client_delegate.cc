// Copyright (c) 2026 Anthropic, PBC.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/webauthn/electron_authenticator_request_client_delegate.h"

#include <algorithm>
#include <array>
#include <iterator>
#include <string>
#include <utility>

#include "base/base64url.h"
#include "base/command_line.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/single_thread_task_runner.h"
#include "base/uuid.h"
#include "build/build_config.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/storage_partition_config.h"
#include "content/public/browser/web_contents.h"
#include "crypto/random.h"
#include "device/fido/authenticator_get_assertion_response.h"
#include "device/fido/cable/v2_handshake.h"
#include "device/fido/fido_authenticator.h"
#include "device/fido/fido_discovery_factory.h"
#include "device/fido/public/fido_transport_protocol.h"
#include "device/fido/public/fido_types.h"
#include "device/fido/public/public_key_credential_descriptor.h"
#include "device/fido/public/public_key_credential_user_entity.h"
#include "gin/arguments.h"
#include "gin/converter.h"
#include "gin/data_object_builder.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "shell/browser/api/electron_api_session.h"
#include "shell/browser/electron_browser_context.h"
#include "shell/browser/javascript_environment.h"
#include "shell/common/gin_converters/callback_converter.h"
#include "shell/common/gin_converters/frame_converter.h"
#include "shell/common/gin_helper/dictionary.h"
#include "shell/common/gin_helper/event.h"
#include "shell/common/gin_helper/event_emitter_caller.h"
#include "third_party/blink/public/mojom/devtools/console_message.mojom.h"
#include "url/origin.h"

#if BUILDFLAG(IS_MAC)
#include "shell/browser/webauthn/electron_authenticator_request_delegate.h"
#include "shell/browser/webauthn/electron_platform_passkeys_discovery.h"
#endif

#if DCHECK_IS_ON()
#include "base/memory/scoped_refptr.h"
#include "device/fido/fido_device_discovery.h"
#include "device/fido/public/fido_constants.h"
#include "device/fido/virtual_ctap2_device.h"
#include "device/fido/virtual_fido_device.h"
#include "device/fido/virtual_fido_device_authenticator.h"
#endif

namespace electron {

namespace {

// WebAuthn's PublicKeyCredential.id is canonically URL-safe base64 with no
// padding, so encode credential IDs and user handles the same way to keep the
// event payload string-comparable to values returned by navigator.credentials.
std::string Base64UrlEncodeNoPad(base::span<const uint8_t> input) {
  std::string out;
  base::Base64UrlEncode(input, base::Base64UrlEncodePolicy::OMIT_PADDING, &out);
  return out;
}

std::string CredentialIdFor(
    const device::AuthenticatorGetAssertionResponse& response) {
  if (response.credential) {
    return Base64UrlEncodeNoPad(response.credential->id);
  }
  return {};
}

#if BUILDFLAG(IS_MAC)
// Mirrors Chromium's cross-origin (iframe) ceremony check.
bool IsSameOriginWithAncestors(content::RenderFrameHost* frame) {
  const url::Origin& origin = frame->GetLastCommittedOrigin();
  for (content::RenderFrameHost* parent = frame->GetParent(); parent;
       parent = parent->GetParent()) {
    if (!parent->GetLastCommittedOrigin().IsSameOriginWith(origin)) {
      return false;
    }
  }
  return true;
}
#endif

#if DCHECK_IS_ON()
bool g_simulate_uv_locked_pin_security_key = false;

// Yields one virtual CTAP 2.1 security key in the state reported in
// https://github.com/electron/electron/issues/54317: built-in user verification
// is configured but has no retries left and a PIN is set, so Chromium reads
// the retry counts and then falls back to collecting the PIN.
class UvLockedPinSecurityKeyDiscovery final
    : public device::FidoDeviceDiscovery {
 public:
  UvLockedPinSecurityKeyDiscovery()
      : device::FidoDeviceDiscovery(device::FidoTransportProtocol::kInternal) {}

 private:
  void StartInternal() override {
    auto state = base::MakeRefCounted<device::VirtualFidoDevice::State>();
    state->transport = device::FidoTransportProtocol::kInternal;
    state->fingerprints_enrolled = true;
    state->uv_retries = 0;
    state->pin = "123456";

    device::VirtualCtap2Device::Config config;
    config.ctap2_versions = {std::begin(device::kCtap2Versions2_1),
                             std::end(device::kCtap2Versions2_1)};
    config.is_platform_authenticator = true;
    config.internal_uv_support = true;
    config.pin_support = true;
    config.pin_uv_auth_token_support = true;
    config.always_uv = true;

    // GetAssertion probes platform authenticators for matching credentials
    // before dispatch, which only the virtual authenticator wrapper answers.
    AddAuthenticator(std::make_unique<device::VirtualFidoDeviceAuthenticator>(
        std::make_unique<device::VirtualCtap2Device>(std::move(state),
                                                     config)));
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&UvLockedPinSecurityKeyDiscovery::NotifyDiscoveryStarted,
                       weak_factory_.GetWeakPtr(), /*success=*/true));
  }

  base::WeakPtrFactory<UvLockedPinSecurityKeyDiscovery> weak_factory_{this};
};
#endif
#if BUILDFLAG(IS_LINUX)
// The caBLE caller dereferences its factory result unconditionally. If the
// owning BrowserContext has gone away, return an inert, disconnected proxy,
// never a null or dangling pointer and never a different profile's context.
// This is UI-sequence-only like the native WebAuthn request delegate.
network::mojom::NetworkContext* ClosedNetworkContext() {
  static base::NoDestructor<mojo::Remote<network::mojom::NetworkContext>> remote;
  if (!remote->is_bound())
    remote->BindNewPipeAndPassReceiver().reset();
  return remote->get();
}

network::mojom::NetworkContext* HybridNetworkContext(
    base::WeakPtr<ElectronBrowserContext> browser_context,
    const content::StoragePartitionConfig& config) {
  if (!browser_context || browser_context->ShutdownStarted())
    return ClosedNetworkContext();
  auto* partition = browser_context->GetStoragePartition(config, false);
  return partition ? partition->GetNetworkContext() : ClosedNetworkContext();
}

#endif  // BUILDFLAG(IS_LINUX)

// Post rather than emit from native teardown: JS must not re-enter a partially
// destroyed RequestState. The weak BrowserContext prevents use after shutdown;
// FromBrowserContext only retrieves an existing Session, it does not create one.
void NotifyHybridEnded(base::WeakPtr<ElectronBrowserContext> browser_context,
                       std::string request_id,
                       HybridRequestHandler owner) {
  if (!browser_context || browser_context->ShutdownStarted() || !owner)
    return;
  auto* session = api::Session::FromBrowserContext(browser_context.get());
  if (!session || !session->Get())
    return;
  v8::Isolate* isolate = JavascriptEnvironment::GetIsolate();
  if (!isolate)
    return;
  v8::HandleScope scope(isolate);
  v8::Local<v8::Object> wrapper;
  if (!session->Get()->GetWrapper(isolate).ToLocal(&wrapper))
    return;
  auto details = gin::DataObjectBuilder(isolate)
                     .Set("requestId", request_id)
                     .Set("state", "ended").Build();
  v8::TryCatch try_catch(isolate);
  owner.Run(details, v8::Undefined(isolate));
  // Teardown is already complete. Contain ordinary UI errors without exposing
  // exception text or reviving the request; preserve V8 termination.
  if (try_catch.HasCaught() && !try_catch.HasTerminated())
    try_catch.Reset();
}

}  // namespace

#if DCHECK_IS_ON()
// static
void ElectronAuthenticatorRequestClientDelegate::
    SetSimulateUvLockedPinSecurityKeyForTesting(bool enabled) {
  g_simulate_uv_locked_pin_security_key = enabled;
}
#endif

ElectronAuthenticatorRequestClientDelegate::
    ElectronAuthenticatorRequestClientDelegate(
        content::RenderFrameHost* render_frame_host)
    : render_frame_host_id_(render_frame_host->GetGlobalId()) {}

ElectronAuthenticatorRequestClientDelegate::
    ~ElectronAuthenticatorRequestClientDelegate() {
  weak_factory_.InvalidateWeakPtrs();
  FinishHybridRequest();
}

#if DCHECK_IS_ON() && BUILDFLAG(IS_LINUX)
network::mojom::NetworkContext*
ElectronAuthenticatorRequestClientDelegate::ResolveHybridNetworkContextForTesting(
    base::WeakPtr<ElectronBrowserContext> browser_context,
    const content::StoragePartitionConfig& config) {
  return HybridNetworkContext(std::move(browser_context), config);
}
#endif

void ElectronAuthenticatorRequestClientDelegate::SetUIPresentation(
    UIPresentation presentation) {
  presentation_ = presentation;
}

void ElectronAuthenticatorRequestClientDelegate::ConfigureDiscoveries(
    const url::Origin& origin,
    const std::string& rp_id,
    RequestSource request_source,
    device::FidoRequestType request_type,
    std::optional<device::ResidentKeyRequirement>,
    device::UserVerificationRequirement,
    bool cmtg_key_requested,
    std::optional<std::string_view>,
    bool,
    device::FidoDiscoveryFactory* discovery_factory) {
#if BUILDFLAG(IS_LINUX)
  auto* rfh = content::RenderFrameHost::FromID(render_frame_host_id_);
  if (!rfh || !rfh->IsActive())
    return;
  auto* session = api::Session::FromBrowserContext(rfh->GetBrowserContext());
  if (!session || !session->Get())
    return;
  const bool enabled = base::CommandLine::ForCurrentProcess()->HasSwitch(
      "enable-electron-webauthn-hybrid");
  const bool modal_get = presentation_ == UIPresentation::kModal &&
      request_source == RequestSource::kWebAuthentication &&
      request_type == device::FidoRequestType::kGetAssertion &&
      !cmtg_key_requested;
  // Native snapshot only: never invoke JavaScript while the outer Chromium
  // caller is still constructing its request handler.
  auto owner = session->Get()->GetWebAuthnHybridHandler();
  if (!owner)
    return;
  if (!hybrid_state_.Configure(
          enabled, modal_get,
          IsVirtualEnvironmentEnabled() ||
              (discovery_factory && discovery_factory->IsTestOverride()),
          discovery_factory != nullptr)) {
    return;
  }

  hybrid_handler_ = std::move(owner);

  // This is a trusted Chromium callback, after origin/RP validation. Never
  // accept an origin, RP ID, challenge, UP/UV flag, or assertion from app JS.
  hybrid_origin_ = origin.Serialize();
  relying_party_id_ = rp_id;
  hybrid_request_id_ = base::Uuid::GenerateRandomV4().AsLowercaseString();
  hybrid_browser_context_ = session->Get()->browser_context()->GetWeakPtr();
  std::array<uint8_t, device::cablev2::kQRKeySize> key;
  crypto::RandBytes(key);
  hybrid_qr_ = device::cablev2::qr::Encode(key, request_type);
  discovery_factory->set_cable_data(request_type, key);

  // Resolve the existing partition on every call via its weak owning context.
  // Do not retain a raw StoragePartition or recreate one after shutdown.
  discovery_factory->set_network_context_factory(base::BindRepeating(
      &HybridNetworkContext, hybrid_browser_context_,
      rfh->GetStoragePartition()->GetConfig()));

  // Do NOT emit JS here: RegisterActionCallbacks has not yet been called.
  // No pairing callback is installed, so no remembered-phone pairing is saved.
#else
  (void)origin;
  (void)rp_id;
  (void)request_source;
  (void)request_type;
  (void)cmtg_key_requested;
  (void)discovery_factory;
#endif
}

void ElectronAuthenticatorRequestClientDelegate::UpdateHybridTransportAvailability(
    const device::FidoRequestHandlerBase::TransportAvailabilityInfo& data) {
  if (!hybrid_state_.active())
    return;
  hybrid_transport_present_ = data.available_transports.contains(
      device::FidoTransportProtocol::kHybrid);
  if (!hybrid_transport_present_)
    return;
  const bool available =
      data.ble_status == device::FidoRequestHandlerBase::BleStatus::kOn;
  if (hybrid_state_.SetAvailable(available))
    EmitHybridRequest(available);
}

void ElectronAuthenticatorRequestClientDelegate::BluetoothAdapterStatusChanged(
    device::FidoRequestHandlerBase::BleStatus status) {
  const bool available = status == device::FidoRequestHandlerBase::BleStatus::kOn;
  if (hybrid_transport_present_ && hybrid_state_.SetAvailable(available))
    EmitHybridRequest(available);
}

void ElectronAuthenticatorRequestClientDelegate::EmitHybridRequest(bool available) {
  auto* rfh = content::RenderFrameHost::FromID(render_frame_host_id_);
  auto* session = hybrid_browser_context_
      ? api::Session::FromBrowserContext(hybrid_browser_context_.get()) : nullptr;
  if (!rfh || !rfh->IsActive() || !hybrid_browser_context_ ||
      hybrid_browser_context_->ShutdownStarted() || !session || !session->Get() ||
      !cancel_callback_ || !hybrid_handler_) {
    CancelHybridRequest();
    return;
  }
  v8::Isolate* isolate = JavascriptEnvironment::GetIsolate();
  v8::HandleScope scope(isolate);
  auto details = gin::DataObjectBuilder(isolate)
      .Set("requestId", hybrid_request_id_)
      .Set("origin", hybrid_origin_)
      .Set("relyingPartyId", relying_party_id_)
      .Set("frame", rfh)
      .Set("state", std::string(available ? "ready" : "unavailable"))
      .Set("qrCode", available ? hybrid_qr_ : std::string()).Build();
  auto weak_this = weak_factory_.GetWeakPtr();
  // Repeating JS cancellation is intentional. It captures only a native WeakPtr,
  // not a JS object or owning reference; duplicate/stale calls are inert.
  auto cancel = gin_helper::CallbackToV8Leaked(isolate, base::BindRepeating(
      &ElectronAuthenticatorRequestClientDelegate::CancelHybridRequest,
      weak_this));
  auto owner = hybrid_handler_;
  v8::TryCatch try_catch(isolate);
  auto acknowledgement = owner.Run(details, cancel);
  const bool owner_threw = try_catch.HasCaught();
  if (try_catch.HasTerminated())
    return;
  if (owner_threw)
    try_catch.Reset();
  if (!weak_this)
    return;
  // Owner failure is a whole-ceremony error, unlike transport unavailability.
  if (owner_threw || acknowledgement.IsEmpty() || !acknowledgement->IsTrue())
    CancelHybridRequest();
}

void ElectronAuthenticatorRequestClientDelegate::CancelHybridRequest() {
  if (!hybrid_state_.TakeCancel())
    return;
  // Consume native OnceClosure last; it can synchronously destroy this object.
  if (cancel_callback_)
    std::move(cancel_callback_).Run();
}

void ElectronAuthenticatorRequestClientDelegate::FinishHybridRequest() {
  hybrid_state_.Close();
  hybrid_qr_.clear();
  if (hybrid_state_.TakeCloseNotification()) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&NotifyHybridEnded, hybrid_browser_context_,
                                 hybrid_request_id_, std::move(hybrid_handler_)));
  }
}

void ElectronAuthenticatorRequestClientDelegate::SetRelyingPartyId(
    const std::string& rp_id) {
  relying_party_id_ = rp_id;
}

void ElectronAuthenticatorRequestClientDelegate::StartObserving(
    device::FidoRequestHandlerBase* request_handler) {
  request_handler_observation_.Observe(request_handler);
}

void ElectronAuthenticatorRequestClientDelegate::StopObserving(
    device::FidoRequestHandlerBase* request_handler) {
  request_handler_observation_.Reset();
  FinishHybridRequest();
}

void ElectronAuthenticatorRequestClientDelegate::RegisterActionCallbacks(
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
        request_ble_permission_callback) {
  cancel_callback_ = std::move(cancel_callback);
  request_callback_ = std::move(request_callback);
}

void ElectronAuthenticatorRequestClientDelegate::SelectAccount(
    std::vector<device::AuthenticatorGetAssertionResponse> responses,
    base::OnceCallback<void(device::AuthenticatorGetAssertionResponse)>
        callback) {
  DCHECK(!responses.empty());

  content::RenderFrameHost* rfh =
      content::RenderFrameHost::FromID(render_frame_host_id_);
  content::WebContents* web_contents =
      rfh ? content::WebContents::FromRenderFrameHost(rfh) : nullptr;
  gin::WeakCell<api::Session>* session =
      web_contents
          ? api::Session::FromBrowserContext(web_contents->GetBrowserContext())
          : nullptr;

  pending_responses_ = std::move(responses);
  select_account_callback_ = std::move(callback);

  if (!session || !session->Get()) {
    CancelPendingAccountSelection();
    return;
  }

  v8::Isolate* isolate = JavascriptEnvironment::GetIsolate();
  v8::HandleScope scope(isolate);

  v8::Local<v8::Array> accounts =
      v8::Array::New(isolate, static_cast<int>(pending_responses_.size()));
  for (size_t i = 0; i < pending_responses_.size(); ++i) {
    const auto& response = pending_responses_[i];
    gin::DataObjectBuilder account(isolate);
    account.Set("credentialId", CredentialIdFor(response));
    if (response.user_entity) {
      account.Set("userHandle", Base64UrlEncodeNoPad(response.user_entity->id));
      if (response.user_entity->name) {
        account.Set("name", *response.user_entity->name);
      }
      if (response.user_entity->display_name) {
        account.Set("displayName", *response.user_entity->display_name);
      }
    }
    accounts
        ->CreateDataProperty(isolate->GetCurrentContext(),
                             static_cast<uint32_t>(i), account.Build())
        .Check();
  }

  v8::Local<v8::Object> details = gin::DataObjectBuilder(isolate)
                                      .Set("relyingPartyId", relying_party_id_)
                                      .Set("accounts", accounts)
                                      .Set("frame", rfh)
                                      .Build();

  v8::Local<v8::Object> session_wrapper;
  if (!session->Get()->GetWrapper(isolate).ToLocal(&session_wrapper)) {
    CancelPendingAccountSelection();
    return;
  }

  v8::Local<v8::Object> event_object = gin_helper::internal::Event::New(isolate)
                                           ->GetWrapper(isolate)
                                           .ToLocalChecked();

  // A listener that runs the callback synchronously completes the request,
  // which may destroy |this| before EmitEvent returns.
  base::WeakPtr<ElectronAuthenticatorRequestClientDelegate> weak_this =
      weak_factory_.GetWeakPtr();
  v8::Local<v8::Value> emit_result = gin_helper::EmitEvent(
      isolate, session_wrapper, "select-webauthn-account", event_object,
      details,
      base::BindRepeating(
          &ElectronAuthenticatorRequestClientDelegate::OnAccountSelected,
          weak_factory_.GetWeakPtr()));
  if (!weak_this) {
    return;
  }

  // EventEmitter.prototype.emit() returns true iff there was at least one
  // listener. With no listener there is no way for the app to choose an
  // account, so cancel rather than silently picking one.
  bool had_listener = false;
  if (!gin::ConvertFromV8(isolate, emit_result, &had_listener) ||
      !had_listener) {
    CancelPendingAccountSelection();
  }
}

void ElectronAuthenticatorRequestClientDelegate::
    CancelPendingAccountSelection() {
  pending_responses_.clear();
  select_account_callback_.Reset();
  CancelRequest();
}

void ElectronAuthenticatorRequestClientDelegate::CancelRequest() {
  if (cancel_callback_) {
    std::move(cancel_callback_).Run();
  }
}

void ElectronAuthenticatorRequestClientDelegate::OnAccountSelected(
    gin::Arguments* args) {
  if (!select_account_callback_) {
    return;
  }

  std::string credential_id;
  if (!args->GetNext(&credential_id) || credential_id.empty()) {
    CancelPendingAccountSelection();
    return;
  }

  for (auto& response : pending_responses_) {
    if (CredentialIdFor(response) == credential_id) {
      auto selected = std::move(response);
      pending_responses_.clear();
      std::move(select_account_callback_).Run(std::move(selected));
      return;
    }
  }

  // Unknown credentialId: cancel the pending request rather than leaving it
  // hanging. Matches the no-args branch above so the listener has a single,
  // consistent failure mode whether it cancels deliberately or by mistake.
  CancelPendingAccountSelection();
}

bool ElectronAuthenticatorRequestClientDelegate::
    EmbedderControlsAuthenticatorDispatch(
        const device::FidoAuthenticator& authenticator) {
#if BUILDFLAG(IS_MAC)
  if (authenticator.AuthenticatorTransport() !=
      device::FidoTransportProtocol::kInternal) {
    return false;
  }

  // Only intercept dispatch when both Touch ID and platform passkeys are
  // configured — that's the only scenario where dual prompts can appear.
  // When only one is configured, Chromium's auto-dispatch is correct.
  if (!ElectronWebAuthenticationDelegate::IsPlatformPasskeysEnabled() ||
      !ElectronWebAuthenticationDelegate::IsTouchIdConfigured()) {
    return false;
  }

  auto type = authenticator.GetType();
  if (type == device::AuthenticatorType::kTouchID ||
      type == device::AuthenticatorType::kICloudKeychain) {
    controls_dispatch_ = true;
    return true;
  }
#endif
  return false;
}

void ElectronAuthenticatorRequestClientDelegate::FidoAuthenticatorAdded(
    const device::FidoAuthenticator& authenticator) {
  if (!controls_dispatch_)
    return;

  std::string display_name;
  switch (authenticator.GetType()) {
    case device::AuthenticatorType::kTouchID:
      display_name = "touchID";
      break;
    case device::AuthenticatorType::kICloudKeychain:
      display_name = "platformPasskeys";
      break;
    default:
      return;
  }

  pending_authenticators_.push_back(
      {authenticator.GetId(), std::move(display_name)});
}

void ElectronAuthenticatorRequestClientDelegate::
    OnTransportAvailabilityEnumerated(
        device::FidoRequestHandlerBase::TransportAvailabilityInfo data) {
#if BUILDFLAG(IS_LINUX)
  // The owner callback may synchronously cancel and destroy this delegate.
  auto weak_this = weak_factory_.GetWeakPtr();
  UpdateHybridTransportAvailability(data);
  if (!weak_this)
    return;
#endif
  if (!controls_dispatch_ || pending_authenticators_.empty())
    return;
  MaybeEmitSelectAuthenticatorEvent();
}

void ElectronAuthenticatorRequestClientDelegate::
    MaybeEmitSelectAuthenticatorEvent() {
  if (pending_authenticators_.size() == 1) {
    // Run may destroy |this|; consume member state first.
    std::string id = std::move(pending_authenticators_[0].id);
    pending_authenticators_.clear();
    auto callback = request_callback_;
    callback.Run(id);
    return;
  }

  content::RenderFrameHost* rfh =
      content::RenderFrameHost::FromID(render_frame_host_id_);
  content::WebContents* web_contents =
      rfh ? content::WebContents::FromRenderFrameHost(rfh) : nullptr;
  gin::WeakCell<api::Session>* session =
      web_contents
          ? api::Session::FromBrowserContext(web_contents->GetBrowserContext())
          : nullptr;

  if (!session || !session->Get()) {
    DispatchDefaultAuthenticator();
    return;
  }

  v8::Isolate* isolate = JavascriptEnvironment::GetIsolate();
  v8::HandleScope scope(isolate);

  std::vector<std::string> authenticators;
  authenticators.reserve(pending_authenticators_.size());
  for (const auto& authenticator : pending_authenticators_) {
    authenticators.push_back(authenticator.display_name);
  }

  v8::Local<v8::Object> session_wrapper;
  if (!session->Get()->GetWrapper(isolate).ToLocal(&session_wrapper)) {
    DispatchDefaultAuthenticator();
    return;
  }

  gin_helper::internal::Event* event =
      gin_helper::internal::Event::New(isolate);
  v8::Local<v8::Object> event_object =
      event->GetWrapper(isolate).ToLocalChecked();

  gin_helper::Dictionary dict(isolate, event_object);
  dict.Set("relyingPartyId", relying_party_id_);
  dict.Set("authenticators", authenticators);
  dict.SetGetter("frame", rfh);

  // A listener that runs the callback synchronously dispatches the request,
  // which may destroy |this| before EmitEvent returns.
  base::WeakPtr<ElectronAuthenticatorRequestClientDelegate> weak_this =
      weak_factory_.GetWeakPtr();
  v8::Local<v8::Value> emit_result = gin_helper::EmitEvent(
      isolate, session_wrapper, "select-webauthn-authenticator", event_object,
      base::BindRepeating(
          &ElectronAuthenticatorRequestClientDelegate::OnAuthenticatorSelected,
          weak_factory_.GetWeakPtr()));
  if (!weak_this) {
    return;
  }

  bool had_listener = false;
  if (!gin::ConvertFromV8(isolate, emit_result, &had_listener) ||
      !had_listener) {
    DispatchDefaultAuthenticator();
  }
}

void ElectronAuthenticatorRequestClientDelegate::
    DispatchDefaultAuthenticator() {
  // A listener may have consumed the selection synchronously and then thrown.
  if (pending_authenticators_.empty()) {
    return;
  }
  auto auth = std::ranges::find(pending_authenticators_, "platformPasskeys",
                                &PendingAuthenticator::display_name);
  // Run may destroy |this|; consume member state first.
  std::string id = std::move(auth != pending_authenticators_.end()
                                 ? auth->id
                                 : pending_authenticators_.front().id);
  pending_authenticators_.clear();
  auto callback = request_callback_;
  callback.Run(id);
}

void ElectronAuthenticatorRequestClientDelegate::OnAuthenticatorSelected(
    gin::Arguments* args) {
  // Repeating callback: ignore any call after the first.
  if (pending_authenticators_.empty()) {
    return;
  }

  std::string selected_name;
  const bool has_name = args->GetNext(&selected_name) && !selected_name.empty();
  const auto selected =
      has_name ? std::ranges::find(pending_authenticators_, selected_name,
                                   &PendingAuthenticator::display_name)
               : pending_authenticators_.end();

  // Run may destroy |this|; consume member state first.
  if (selected != pending_authenticators_.end()) {
    std::string id = std::move(selected->id);
    pending_authenticators_.clear();
    auto callback = request_callback_;
    callback.Run(id);
    return;
  }

  // No argument, empty, or unknown name: cancel.
  pending_authenticators_.clear();
  if (cancel_callback_) {
    std::move(cancel_callback_).Run();
  }
}

void ElectronAuthenticatorRequestClientDelegate::CollectPIN(
    CollectPINOptions options,
    base::OnceCallback<void(std::u16string)> provide_pin_cb) {
  // SupportsPIN() is false, so Chromium never plans to use a PIN, but it still
  // ends up here when a security key's built-in user verification is locked or
  // gets blocked mid-request and the key has a PIN to fall back to. There is no
  // PIN prompt, so fail the request rather than hit the default NOTREACHED().
  if (auto* rfh = content::RenderFrameHost::FromID(render_frame_host_id_)) {
    rfh->AddMessageToConsole(
        blink::mojom::ConsoleMessageLevel::kWarning,
        "The security key needs its PIN to continue, but Electron does not "
        "support WebAuthn PIN entry "
        "(https://github.com/electron/electron/issues/24573). The request "
        "was cancelled.");
  }
  // This runs inside the FIDO device's response handling, which cancelling
  // destroys, so cancel from a fresh task.
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(&ElectronAuthenticatorRequestClientDelegate::CancelRequest,
                     weak_factory_.GetWeakPtr()));
}

std::vector<std::unique_ptr<device::FidoDiscoveryBase>>
ElectronAuthenticatorRequestClientDelegate::CreatePlatformDiscoveries() {
  std::vector<std::unique_ptr<device::FidoDiscoveryBase>> discoveries;
#if DCHECK_IS_ON()
  if (g_simulate_uv_locked_pin_security_key) {
    discoveries.push_back(std::make_unique<UvLockedPinSecurityKeyDiscovery>());
  }
#endif
#if BUILDFLAG(IS_MAC)
  if (ElectronWebAuthenticationDelegate::IsPlatformPasskeysEnabled()) {
    auto* rfh = content::RenderFrameHost::FromID(render_frame_host_id_);
    if (rfh && IsSameOriginWithAncestors(rfh)) {
      discoveries.push_back(
          std::make_unique<ElectronPlatformPasskeysDiscovery>(rfh));
    } else if (rfh) {
      // Apple's API can't serve cross-origin ceremonies; other authenticators
      // still can.
      rfh->AddMessageToConsole(
          blink::mojom::ConsoleMessageLevel::kWarning,
          "WebAuthn platform passkeys are unavailable to cross-origin "
          "(iframe) requests: Apple's ASAuthorizationController cannot "
          "fulfill them. Other authenticators can still serve the request; "
          "the Touch ID authenticator supports iframes.");
    }
  }
#endif
  return discoveries;
}

}  // namespace electron
