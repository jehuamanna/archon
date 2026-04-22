import React from "react";

export function ArchonLogo({
  className,
  title,
}: {
  className?: string;
  title?: string;
}): React.ReactElement {
  return (
    <svg
      className={className}
      width="128"
      height="128"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={title ?? "Archon"}
      role="img"
    >
      {title ? <title>{title}</title> : null}
      <circle cx="20" cy="44" r="5" fill="currentColor" />
      <circle cx="44" cy="20" r="5" fill="currentColor" />
      <rect
        x="22"
        y="38"
        width="28"
        height="4"
        rx="2"
        transform="rotate(-45 22 38)"
        fill="currentColor"
      />
    </svg>
  );
}

