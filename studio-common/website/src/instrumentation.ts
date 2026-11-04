export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { projectRuntime } = await import("./lib/project-runtime");
      projectRuntime();
    } catch (error) {
      // Next can log a rejected register() yet keep accepting requests; configuration
      // isolation is fatal and must stop the process before its server becomes ready.
      console.error(`站点配置验证失败：${error instanceof Error ? error.message : "配置检查异常"}`);
      process.exit(1);
    }
  }
}
