const pad = (n: number) => String(n).padStart(2, '0');

export const toISODate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function parseISODate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const addDays = (iso: string, days: number) => {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
};

// "Sat, 24 Oct 2026"
export const prettyDate = (iso: string) =>
  parseISODate(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

// "24 Oct 2026"
export const shortDate = (iso: string) =>
  parseISODate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const hourLabel = (h: number) => `${h % 12 || 12}:00 ${h % 24 < 12 ? 'AM' : 'PM'}`;

// "7:00 PM – 8:00 PM"
export const slotRange = (h: number) => `${hourLabel(h)} – ${hourLabel(h + 1)}`;

export const rupees = (n: number) => `${n < 0 ? '–' : ''}₹${Math.abs(n).toLocaleString('en-IN')}`;

export const maskPhone = (p: string) => `+91 ${p.slice(0, 5)} ${p.slice(5)}`;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
