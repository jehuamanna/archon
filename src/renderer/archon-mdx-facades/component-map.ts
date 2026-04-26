import React from "react";
import { formatIsoDate } from "./date";
import { Alert, Badge, Button as UiButton, Counter, Disclosure, Separator, Tab, TabList, TabPanel, Tabs, TextInput } from "./ui";
import { getArchonMdxSdkFacadeComponentMap } from "./mdx-sdk";

/**
 * JSX tags available in MDX. Three virtual import facades resolve here:
 * - `@archon/ui`      → self-contained widgets with local React state (Alert, Badge, Counter, Disclosure, Separator, TextInput, Tabs…)
 * - `@archon/date`    → date formatting helper `<ArchonFormatIso>`.
 * - `@archon/mdx-sdk` → project-state-backed components (Input, Select, Checkbox, PushButton, Value, List, Table, Chart, NoteEmbed, Markdown, Form, Code, Slideshow, Button state-counter).
 *
 * `@archon/mdx-sdk`'s `Button` subsumes `@archon/ui`'s — a string `onClick=…`
 * makes it a project-state counter, otherwise it behaves as the old plain button.
 *
 * Imports are stripped by `remarkArchonMdxFacadeImports`; tag names must match what authors import.
 */
export function getArchonMdxFacadeComponentMap(): Record<string, React.ComponentType<Record<string, unknown>>> {
  const uiMap: Record<string, React.ComponentType<Record<string, unknown>>> = {
    // `@archon/ui` facade
    Button: UiButton as unknown as React.ComponentType<Record<string, unknown>>,
    Badge: Badge as unknown as React.ComponentType<Record<string, unknown>>,
    Counter: Counter as unknown as React.ComponentType<Record<string, unknown>>,
    Disclosure: Disclosure as unknown as React.ComponentType<Record<string, unknown>>,
    Separator: Separator as unknown as React.ComponentType<Record<string, unknown>>,
    TextInput: TextInput as unknown as React.ComponentType<Record<string, unknown>>,
    Alert: Alert as unknown as React.ComponentType<Record<string, unknown>>,
    Tabs: Tabs as unknown as React.ComponentType<Record<string, unknown>>,
    TabList: TabList as unknown as React.ComponentType<Record<string, unknown>>,
    Tab: Tab as unknown as React.ComponentType<Record<string, unknown>>,
    TabPanel: TabPanel as unknown as React.ComponentType<Record<string, unknown>>,
    /** `@archon/date` facade — expressions are blocked for user MDX so a tag form is the safe path. */
    ArchonFormatIso: (({ value }: { value?: string }) =>
      React.createElement(
        "span",
        { className: "font-mono text-[13px]" },
        value ? formatIsoDate(value) : "",
      )) as unknown as React.ComponentType<Record<string, unknown>>,
  };
  // `@archon/mdx-sdk` wins on tag-name collisions (today: Button), so mini-app
  // notes get the state-backed Button; plain UI notes that never pass `onClick`
  // still render correctly because the SDK Button falls back to children/label.
  return { ...uiMap, ...getArchonMdxSdkFacadeComponentMap() };
}
