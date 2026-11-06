import { getAutoRunSettings } from "@/lib/auto-run-settings";
import { AutoRunSettingsForm } from "./settings-form";
export const dynamic="force-dynamic";
export default async function SettingsPage() {
  return <main className="mx-auto max-w-3xl space-y-6 p-3 sm:p-6"><div><h1 className="text-2xl font-semibold">接口配置</h1><p className="mt-2 text-sm text-zinc-400">配置本项目自动流程使用的大模型接口。新任务开始时固定接口，运行中的任务继续使用启动时的配置。</p></div><AutoRunSettingsForm initial={await getAutoRunSettings()}/></main>;
}
