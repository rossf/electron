// Isolated regression probe: no browser, profile, network or WebAuthn.
#include "base/at_exit.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/synchronization/waitable_event.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool/thread_pool_instance.h"
#include "base/threading/thread_restrictions.h"
#include "components/services/storage/dom_storage/dom_storage_database.h"

int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  base::ThreadPoolInstance::CreateAndStartWithDefaultParams("StorageShutdown");
  base::WaitableEvent done;
  storage::GetTaskRunnerForDb(base::FilePath())->PostTask(
      FROM_HERE, base::BindOnce([](base::WaitableEvent* done) {
        // LevelDB destruction may wait for background compaction even when
        // its database is in memory. This deterministically checks the actual
        // production runner's contract, independent of compaction timing.
        base::AssertBlockingAllowed();
        done->Signal();
      }, &done));
  done.Wait();
  base::ThreadPoolInstance::Get()->Shutdown();
  base::ThreadPoolInstance::Get()->JoinForTesting();
  return 0;
}
