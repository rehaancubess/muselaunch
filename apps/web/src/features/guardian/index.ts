/**
 * Owner: module G (Brand Guardian) — Muse Glimmer (local) + deterministic brand rules.
 * `<BrandGuardianPanel subject version? onApplied? onFocus?/>` (Studio "Brand" tab),
 * `<BrandGuardianBadge subject version?/>` (render + approval dialogs), `<BrandOverrideForm/>` and
 * `<GuardedApprovalButton/>` for the override flow when a review is blocked.
 */
export { BrandGuardianPanel, type BrandGuardianPanelProps } from "./panel";
export { BrandGuardianBadge, BrandOverrideForm, GuardedApprovalButton } from "./badge";
export { EngineBadge, ReviewStatus } from "./parts";
export { brandBlockOf, isBrandReviewRunning, useBrandReviews, type ApplyFindingResponse, type GuardianSubject, type ReviewBrief } from "./use-guardian";
