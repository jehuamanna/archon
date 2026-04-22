import React from "react";

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
    {children}
  </p>
);

export default SectionLabel;
