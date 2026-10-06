// Test-only linked binding. Never linked into the production Electron target.
#include <memory>
#include <set>
#include <utility>
#include <vector>
#include "base/check.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted.h"
#include "base/no_destructor.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/scoped_authenticator_environment_for_testing.h"
#include "device/bluetooth/bluetooth_adapter_factory.h"
#include "device/bluetooth/test/mock_bluetooth_adapter.h"
#include "device/fido/fido_device_discovery.h"
#include "device/fido/fido_discovery_factory.h"
#include "device/fido/virtual_ctap2_device.h"
#include "gin/arguments.h"
#include "gin/data_object_builder.h"
#include "shell/common/gin_helper/dictionary.h"
#include "shell/common/node_includes.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/origin.h"

namespace {
using Adapter = device::BluetoothAdapter;
using Transport = device::FidoTransportProtocol;
struct ProbeState {
  int configured = 0;
  int live = 0;
  int usb_started = 0;
  int hybrid_started = 0;
  bool hybrid_configured = false;
  bool press = true;
  bool powered = true;
  std::set<Adapter::Observer*> observers;
  scoped_refptr<device::VirtualFidoDevice::State> device_state =
      base::MakeRefCounted<device::VirtualFidoDevice::State>();
};

class Discovery final : public device::FidoDeviceDiscovery {
 public:
  Discovery(Transport transport, std::shared_ptr<ProbeState> state)
      : FidoDeviceDiscovery(transport), state_(std::move(state)),
        usb_(transport == Transport::kUsbHumanInterfaceDevice) {
    ++state_->live;
  }
  ~Discovery() override { --state_->live; }
 private:
  void StartInternal() override {
    if (usb_) {
      device::VirtualCtap2Device::Config config;
      config.internal_uv_support = true;
      config.resident_key_support = true;
      config.user_verification_succeeds = true;
      AddDevice(std::make_unique<device::VirtualCtap2Device>(state_->device_state,
                                                          config));
    }
    if (usb_) ++state_->usb_started;
    else ++state_->hybrid_started;
    // FidoDeviceDiscovery::Start has already posted this operation.
    NotifyDiscoveryStarted(true);
  }
  std::shared_ptr<ProbeState> state_;
  bool usb_;
};

class Factory final : public device::FidoDiscoveryFactory {
 public:
  explicit Factory(std::shared_ptr<ProbeState> state) : state_(std::move(state)) {}
  // Deliberately leave IsTestOverride false: test the embedder's native path.
  std::vector<std::unique_ptr<device::FidoDiscoveryBase>> Create(
      Transport transport) override {
    if (transport == Transport::kUsbHumanInterfaceDevice ||
        (transport == Transport::kHybrid && state_->hybrid_configured)) {
      return SingleDiscovery(std::make_unique<Discovery>(transport, state_));
    }
    return {};  // Never call the base factory for any transport.
  }
  std::optional<std::unique_ptr<device::FidoDiscoveryBase>>
  MaybeCreateEnclaveDiscovery() override { return std::nullopt; }
  void set_cable_data(device::FidoRequestType,
      const std::optional<std::array<uint8_t, device::cablev2::kQRKeySize>>& key)
      override {
    CHECK(key.has_value());
    ++state_->configured;
    state_->hybrid_configured = true;
    // No retained QR key, network factory invocation, tunnel or Bluetooth scan.
  }
 private:
  std::shared_ptr<ProbeState> state_;
};

struct Harness {
  std::shared_ptr<ProbeState> state = std::make_shared<ProbeState>();
  scoped_refptr<testing::StrictMock<device::MockBluetoothAdapter>> adapter;
  std::unique_ptr<device::BluetoothAdapterFactory::GlobalOverrideValues> overrides;
  std::unique_ptr<content::ScopedAuthenticatorEnvironmentForTesting> environment;
};
std::unique_ptr<Harness>& Current() {
  static base::NoDestructor<std::unique_ptr<Harness>> current;
  return *current;
}

void Install(int process_id, int routing_id, gin::Arguments* args) {
  auto* frame = content::RenderFrameHost::FromID(process_id, routing_id);
  if (Current() || !frame || !frame->IsActive() ||
      !frame->GetBrowserContext()->IsOffTheRecord() ||
      frame->GetLastCommittedOrigin().scheme() != "http" ||
      frame->GetLastCommittedOrigin().host() != "localhost" ||
      device::BluetoothAdapterFactory::HasSharedInstanceForTesting()) {
    args->ThrowTypeError("Requires fresh test process and active disposable localhost frame");
    return;
  }
  auto harness = std::make_unique<Harness>();
  auto state = harness->state;
  state->device_state->fingerprints_enrolled = true;
  // A weak capture avoids a cycle through VirtualFidoDevice::State.
  state->device_state->simulate_press_callback = base::BindRepeating(
      [](std::weak_ptr<ProbeState> weak, device::VirtualFidoDevice*) {
        auto value = weak.lock();
        return value && value->press;
      }, std::weak_ptr<ProbeState>(state));
  harness->adapter = base::MakeRefCounted<
      testing::StrictMock<device::MockBluetoothAdapter>>();
  auto& adapter = *harness->adapter;
  using testing::_;
  using testing::AnyNumber;
  EXPECT_CALL(adapter, IsPresent()).Times(AnyNumber()).WillRepeatedly(testing::Return(true));
  EXPECT_CALL(adapter, IsPowered()).Times(AnyNumber()).WillRepeatedly([state] { return state->powered; });
  EXPECT_CALL(adapter, GetOsPermissionStatus()).Times(AnyNumber())
      .WillRepeatedly(testing::Return(Adapter::PermissionStatus::kAllowed));
  EXPECT_CALL(adapter, CanPower()).Times(AnyNumber()).WillRepeatedly(testing::Return(false));
  EXPECT_CALL(adapter, AddObserver(_)).Times(AnyNumber()).WillRepeatedly(
      [state](Adapter::Observer* observer) { CHECK(state->observers.insert(observer).second); });
  EXPECT_CALL(adapter, RemoveObserver(_)).Times(AnyNumber()).WillRepeatedly(
      [state](Adapter::Observer* observer) { CHECK_EQ(state->observers.erase(observer), 1u); });
  // Unlisted methods (power, permissions, scan, connect) are strict failures.
  harness->overrides = device::BluetoothAdapterFactory::Get()->InitGlobalOverrideValues();
  harness->overrides->SetLESupported(true);
  device::BluetoothAdapterFactory::SetAdapterForTesting(harness->adapter);
  harness->environment = std::make_unique<content::ScopedAuthenticatorEnvironmentForTesting>(
      std::make_unique<Factory>(state));
  Current() = std::move(harness);
}

void Prepare(bool powered, bool press, gin::Arguments* args) {
  if (!Current() || Current()->state->live || !Current()->state->observers.empty()) {
    args->ThrowTypeError("Cannot reset while native request owns discovery or adapter observers");
    return;
  }
  auto& state = *Current()->state;
  state.configured = state.usb_started = state.hybrid_started = 0;
  state.hybrid_configured = false;
  state.powered = powered;
  state.press = press;
}

void SetPowered(bool powered, gin::Arguments* args) {
  if (!Current()) { args->ThrowTypeError("Harness not installed"); return; }
  auto state = Current()->state;
  auto adapter = Current()->adapter;  // Keep alive across reentrant teardown.
  state->powered = powered;
  const auto observers = state->observers;
  for (auto* observer : observers) {
    if (state->observers.contains(observer))
      observer->AdapterPoweredChanged(adapter.get(), powered);
  }
}

v8::Local<v8::Value> Stats(v8::Isolate* isolate) {
  CHECK(Current());
  auto& state = *Current()->state;
  return gin::DataObjectBuilder(isolate)
      .Set("configured", state.configured).Set("live", state.live)
      .Set("usbStarted", state.usb_started).Set("hybridStarted", state.hybrid_started)
      .Set("observers", static_cast<int>(state.observers.size()))
      .Set("mockFailed", testing::UnitTest::GetInstance()->Failed()).Build();
}

void Uninstall(gin::Arguments* args) {
  if (!Current() || Current()->state->live || !Current()->state->observers.empty()) {
    args->ThrowTypeError("Abort all ceremonies and drain teardown before uninstall"); return;
  }
  bool ok = testing::Mock::VerifyAndClearExpectations(Current()->adapter.get()) &&
            !testing::UnitTest::GetInstance()->Failed();
  Current()->environment.reset();
  Current()->adapter.reset();
  CHECK(!device::BluetoothAdapterFactory::HasSharedInstanceForTesting());
  Current()->overrides.reset();
  Current().reset();
  if (!ok || testing::UnitTest::GetInstance()->Failed()) args->ThrowTypeError("Mock adapter violation");
}

void Initialize(v8::Local<v8::Object> exports, v8::Local<v8::Value>,
                v8::Local<v8::Context> context, void*) {
  gin_helper::Dictionary dict(v8::Isolate::GetCurrent(), exports);
  dict.SetMethod("install", &Install);
  dict.SetMethod("prepare", &Prepare);
  dict.SetMethod("setPowered", &SetPowered);
  dict.SetMethod("stats", &Stats);
  dict.SetMethod("uninstall", &Uninstall);
}
}  // namespace
NODE_LINKED_BINDING_CONTEXT_AWARE(electron_hybrid_browser_owned_testing, Initialize)
