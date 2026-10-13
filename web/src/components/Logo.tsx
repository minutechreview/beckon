// The Beckon mark: a terminal prompt with a waiting dot, on the brand blue.
// The PWA icons in public/icons are drawn from the same shapes.

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill="#1F5EFF" />
      <path d="M9.5 10.5 15 16l-5.5 5.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21.5" cy="20" r="3" fill="#fff" />
    </svg>
  );
}

/** Mark and wordmark. Wrap it in a link where it navigates. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <>
      <LogoMark size={size} />
      <span>Beckon</span>
    </>
  );
}
