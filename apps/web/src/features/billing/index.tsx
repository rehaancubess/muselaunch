"use client";
/**
 * Owner: module F. Plans, subscription and usage summary. Rendered below the credits overview on
 * /w/[workspaceId]/settings/credits. Replace the internals; keep the default export.
 */
import { CreditCard } from "lucide-react";
import { FeaturePlaceholder } from "../_placeholder";

export default function BillingRoot() {
  return (
    <FeaturePlaceholder
      icon={<CreditCard aria-hidden />}
      title="Plans"
      description="MuseLaunch is in a credits-only beta. Paid plans aren’t available yet, so there’s nothing to buy here."
    />
  );
}
