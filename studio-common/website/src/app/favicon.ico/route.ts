import { projectIconResponse } from "@/lib/project-branding";

export const dynamic = "force-dynamic";

export function GET() {
  return projectIconResponse("ico");
}
