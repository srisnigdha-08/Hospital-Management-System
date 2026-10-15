/**
 * The Meridian signature mark: a calm horizontal rule that resolves into a
 * single measured pulse. Used sparingly — under auth panels and section
 * headers — never as decoration on every card.
 */
export function VitalsDivider({ className = '', tone = 'teal' }) {
  const stroke = tone === 'gold' ? '#C9962B' : tone === 'ink' ? '#0F2540' : '#0D9488';
  return (
    <svg
      viewBox="0 0 320 24"
      className={`h-6 w-full ${className}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line x1="0" y1="12" x2="122" y2="12" stroke="currentColor" strokeOpacity="0.15" strokeWidth="1.5" />
      <polyline
        points="122,12 138,12 146,3 156,21 166,7 174,12 198,12"
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="198" y1="12" x2="320" y2="12" stroke="currentColor" strokeOpacity="0.15" strokeWidth="1.5" />
    </svg>
  );
}
