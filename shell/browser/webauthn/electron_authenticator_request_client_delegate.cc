// Copyright (c) 2026 Anthropic, PBC.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/webauthn/electron_authenticator_request_client_delegate.h"

#include <array>
#include <string>
#include <utility>

#include "base/base64url.h"
#include "base/command_line.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/no_destructor.h"
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
#include "device/fido/fido_discovery_factory.h"
#include "device/fido/public/fido_transport_protocol.h"
#include "device/fido/public/public_key_credential_descriptor.h"
#include "device/fido/public/public_key_credential_user_entity.h"
#include "gin/arguments.h"
#include "gin/data_object_builder.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "shell/browser/api/electron_api_session.h"
#include "shell/browser/electron_browser_context.h"
#include "shell/browser/javascript_environment.h"
#include "shell/common/gin_converters/callback_converter.h"
#include "shell/common/gin_converters/frame_converter.h"
#include "shell/common/gin_helper/event.h"
#include "shell/common/gin_helper/event_emitter_caller.h"
#include "url/origin.h"

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

#if BUILDFLAG(IS_LINUX)
// The caBLE caller dereferences its factory result unconditionally. If the
// owning BrowserContext has gone away, return an inert, disconnected proxy,
// never a null or dangling pointer and never a different profile's context.
// This is UI-sequence-only like the native WebAuthn request delegate.
network::mojom::NetworkContext* ClosedNetworkContext() {
  static base::NoDestructor<mojo::Remote<network::mojom::NetworkContext>>
      remote;
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
// FromBrowserContext only retrieves an existing Session, it does not create
// one.
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
                     .Set("state", "ended")
                     .Build();
  v8::TryCatch try_catch(isolate);
  owner.Run(details, v8::Undefined(isolate));
  // Teardown is already complete. Contain ordinary UI errors without exposing
  // exception text or reviving the request; preserve V8 termination.
  if (try_catch.HasCaught() && !try_catch.HasTerminated())
    try_catch.Reset();
}

}  // namespace

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
network::mojom::NetworkContext* ElectronAuthenticatorRequestClientDelegate::
    ResolveHybridNetworkContextForTesting(
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
                         request_type == device::FidoRequestType::kGetAssertion;
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
  discovery_factory->set_network_context_factory(
      base::BindRepeating(&HybridNetworkContext, hybrid_browser_context_,
                          rfh->GetStoragePartition()->GetConfig()));

  // Do NOT emit JS here: RegisterActionCallbacks has not yet been called.
  // No pairing callback is installed, so no remembered-phone pairing is saved.
#else
  (void)origin;
  (void)rp_id;
  (void)request_source;
  (void)request_type;
  (void)discovery_factory;
#endif
}

void ElectronAuthenticatorRequestClientDelegate::
    OnTransportAvailabilityEnumerated(
        device::FidoRequestHandlerBase::TransportAvailabilityInfo data) {
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
  const bool available =
      status == device::FidoRequestHandlerBase::BleStatus::kOn;
  if (hybrid_transport_present_ && hybrid_state_.SetAvailable(available))
    EmitHybridRequest(available);
}

void ElectronAuthenticatorRequestClientDelegate::EmitHybridRequest(
    bool available) {
  auto* rfh = content::RenderFrameHost::FromID(render_frame_host_id_);
  auto* session =
      hybrid_browser_context_
          ? api::Session::FromBrowserContext(hybrid_browser_context_.get())
          : nullptr;
  if (!rfh || !rfh->IsActive() || !hybrid_browser_context_ ||
      hybrid_browser_context_->ShutdownStarted() || !session ||
      !session->Get() || !cancel_callback_ || !hybrid_handler_) {
    CancelHybridRequest();
    return;
  }
  v8::Isolate* isolate = JavascriptEnvironment::GetIsolate();
  v8::HandleScope scope(isolate);
  auto details =
      gin::DataObjectBuilder(isolate)
          .Set("requestId", hybrid_request_id_)
          .Set("origin", hybrid_origin_)
          .Set("relyingPartyId", relying_party_id_)
          .Set("frame", rfh)
          .Set("state", std::string(available ? "ready" : "unavailable"))
          .Set("qrCode", available ? hybrid_qr_ : std::string())
          .Build();
  auto weak_this = weak_factory_.GetWeakPtr();
  // Repeating JS cancellation is intentional. It captures only a native
  // WeakPtr, not a JS object or owning reference; duplicate/stale calls are
  // inert.
  auto cancel = gin_helper::CallbackToV8Leaked(
      isolate,
      base::BindRepeating(
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
        FROM_HERE,
        base::BindOnce(&NotifyHybridEnded, hybrid_browser_context_,
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

}  // namespace electron
