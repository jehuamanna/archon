import React from "react";
import { formatIsoDate } from "./date";
import { Alert, Badge, Button, Counter, Disclosure, Separator, Tab, TabList, TabPanel, Tabs, TextInput } from "./ui";

/**
 * JSX tags available in MDX matching virtual `@archon/ui` / `@archon/date` exports
 * (imports are stripped; names must match what authors import).
 */
export function getArchonMdxFacadeComponentMap(): Record<string, React.ComponentType<Record<string, unknown>>> {
  return {
    Button,
    Badge,
    Counter,
    Disclosure,
    Separator,
    TextInput,
    Alert,
    Tabs,
    TabList,
    Tab,
    TabPanel,
    /** Date helper: `<ArchonFormatIso value="2024-01-15" />` — expressions are blocked for user MDX so this tag form is the safe path. */
    ArchonFormatIso: ({ value }: { value?: string }) =>
      React.createElement(
        "span",
        { className: "font-mono text-[13px]" },
        value ? formatIsoDate(value) : "",
      ),
  };
}
