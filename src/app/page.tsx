import type { Metadata } from "next";
import { AmbientDashboard } from "@/components/ambient/dashboard/AmbientDashboard";
import { en } from "@/i18n/en";

export const metadata: Metadata = {
  title: en.ambient.meta.title,
  description: en.ambient.meta.description,
  robots: { index: false, follow: false },
};

/**
 * The Ambient app shell: sidebar plus the Time screen. Everything it shows is read from the
 * collector's logs under `~/.ambient/` (see `collector/collect.ps1`).
 *
 * The pipeline-level view lives at `/raw`, which is where to go to see the digest, the
 * per-block content counts and the model's full read.
 */
export default function AmbientPage() {
  return <AmbientDashboard />;
}
