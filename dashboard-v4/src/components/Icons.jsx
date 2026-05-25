import React from 'react';

/* Tiny inline SVG icons + leaf/capsule motifs. All currentColor.
   Usage: <Icon name="home" size={18} />
*/
const Icon = ({ name, size = 18, className = "", style = {} }) => {
  const s = size;
  const common = { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", className, style };
  switch (name) {
    case "home":      return <svg {...common}><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>;
    case "factory":   return <svg {...common}><path d="M3 21V10l5 3V10l5 3V10l5 3v8z"/><path d="M9 21v-5h2v5"/><path d="M14 21v-5h2v5"/></svg>;
    case "pp":        return <svg {...common}><path d="M21 8 12 3 3 8l9 5 9-5z"/><path d="m3 8 0 8 9 5 9-5V8"/><path d="M12 13v8"/></svg>;
    case "support":   return <svg {...common}><path d="M12 22a8 8 0 1 0-8-8"/><path d="M8 14a4 4 0 1 1 4 4"/><circle cx="12" cy="18" r="1"/></svg>;
    case "people":    return <svg {...common}><circle cx="9" cy="8" r="3.5"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M14.5 21A5.5 5.5 0 0 1 21 16.5"/></svg>;
    case "target":    return <svg {...common}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>;
    case "product":   return <svg {...common}><path d="M3 9.5 12 4l9 5.5v5L12 20l-9-5.5z"/><path d="M3 9.5 12 15l9-5.5"/><path d="M12 15v5"/></svg>;
    case "tv":        return <svg {...common}><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/></svg>;
    case "config":    return <svg {...common}><circle cx="12" cy="12" r="2.8"/><path d="M19.4 14a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V20a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9.07 18.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 7.93a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V2a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H22a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
    case "chat":      return <svg {...common}><path d="M21 12a8 8 0 1 1-3.5-6.6L21 4l-1.4 3.4A8 8 0 0 1 21 12z"/></svg>;
    case "plan":      return <svg {...common}><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="M8 13h3M8 17h6"/></svg>;
    case "plus":      return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case "left":      return <svg {...common}><path d="M15 6l-6 6 6 6"/></svg>;
    case "right":     return <svg {...common}><path d="M9 6l6 6-6 6"/></svg>;
    case "x":         return <svg {...common}><path d="M6 6l12 12M18 6 6 18"/></svg>;
    case "search":    return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
    case "bell":      return <svg {...common}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>;
    case "sun":       return <svg {...common}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>;
    case "moon":      return <svg {...common}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>;
    case "filter":    return <svg {...common}><path d="M3 5h18M6 12h12M10 19h4"/></svg>;
    case "merge":     return <svg {...common}><path d="M8 3v6a6 6 0 0 0 8 4l5 5"/><path d="M16 3v6"/></svg>;
    case "split":     return <svg {...common}><path d="M21 8h-5l-5 5-5-5H3"/><path d="M16 3v5"/></svg>;
    case "edit":      return <svg {...common}><path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z"/></svg>;
    case "trash":     return <svg {...common}><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>;
    case "menu":      return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16"/></svg>;
    case "live":      return <svg {...common}><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="10" opacity="0.4"/></svg>;
    case "link":      return <svg {...common}><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>;
    case "clock":     return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
    case "send":      return <svg {...common}><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>;
    case "calendar":  return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>;
    default: return null;
  }
};

// Leaf SVG accent — used as section markers + decorations
const Leaf = ({ size = 14, color, style = {} }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style} aria-hidden="true">
    <path d="M20 4c-2 8-6 13-14 16 1-7 4-12 8-15a10 10 0 0 1 6-1z" fill={color || "currentColor"} opacity="0.95"/>
    <path d="M20 4c-3 4-8 9-13 14" stroke={color || "#fff"} strokeOpacity="0.4" strokeWidth="0.8"/>
  </svg>
);

// Capsule SVG — pill shape, two-tone
const Capsule = ({ w = 22, h = 10, c1 = "var(--hf-navy-600)", c2 = "var(--hf-leaf-500)", style = {} }) => (
  <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={style} aria-hidden="true">
    <defs>
      <clipPath id={`cap-cp-${w}-${h}`}>
        <rect x="0" y="0" width={w} height={h} rx={h/2} ry={h/2}/>
      </clipPath>
    </defs>
    <g clipPath={`url(#cap-cp-${w}-${h})`}>
      <rect x="0" y="0" width={w/2} height={h} fill={c1}/>
      <rect x={w/2} y="0" width={w/2} height={h} fill={c2}/>
      <rect x="0" y="0" width={w} height={h*0.45} fill="rgba(255,255,255,0.25)"/>
    </g>
    <rect x="0.5" y="0.5" width={w-1} height={h-1} rx={(h-1)/2} ry={(h-1)/2} fill="none" stroke="rgba(0,0,0,0.06)"/>
  </svg>
);

Object.assign(window, { Icon, Leaf, Capsule });

export { Icon, Leaf, Capsule };
