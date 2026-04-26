export type PropSpec = {
  type: "string" | "number" | "boolean" | "enum" | "stateKey" | "noteId";
  required?: boolean;
  enum?: readonly string[];
  default?: unknown;
  semantic?: string;
};

export type ComponentPropSpec = Record<string, PropSpec>;

export const PROP_SPECS: Record<string, ComponentPropSpec> = {
  Input: {
    placeholder: { type: "string", default: "", semantic: "Placeholder text." },
    value: {
      type: "stateKey",
      required: true,
      semantic: "State key holding the current text.",
    },
    onChange: {
      type: "stateKey",
      required: true,
      semantic: "State key to write on each edit (can equal `value`).",
    },
  },
  Select: {
    options: {
      type: "enum",
      required: true,
      semantic: "Comma-separated options.",
    },
    value: { type: "stateKey", required: true, semantic: "State key for the chosen option." },
    onChange: { type: "stateKey", required: true, semantic: "State key to write on change." },
  },
  Checkbox: {
    label: { type: "string", required: true, semantic: "Label next to the checkbox." },
    value: { type: "stateKey", required: true, semantic: "Boolean state key." },
    onChange: { type: "stateKey", required: true, semantic: "State key to write on toggle." },
  },
  Button: {
    label: { type: "string", required: true, semantic: "Button label." },
    onClick: {
      type: "stateKey",
      semantic: "State key used as a counter/command; incremented on each click.",
    },
  },
  Form: {
    submit: {
      type: "stateKey",
      required: true,
      semantic: "State key the assembled form object is written to.",
    },
  },
  List: {
    stateKey: {
      type: "stateKey",
      required: true,
      semantic: "Array state key whose items are rendered.",
    },
    item: {
      type: "string",
      semantic: "Per-item template (uses `{field}` interpolation).",
    },
  },
  Table: {
    stateKey: { type: "stateKey", required: true, semantic: "Array of row objects." },
    columns: {
      type: "enum",
      required: true,
      semantic: "Comma-separated column keys in display order.",
    },
  },
  Chart: {
    stateKey: { type: "stateKey", required: true, semantic: "Array of datapoints." },
    kind: {
      type: "enum",
      required: true,
      enum: ["bar", "line", "pie"],
      default: "bar",
    },
  },
  NoteEmbed: {
    id: { type: "noteId", semantic: "Explicit note id (same project)." },
    title: { type: "string", semantic: "Resolve target by title (same project)." },
  },
  Markdown: {
    source: {
      type: "string",
      required: true,
      semantic: "Markdown source; rendered with sanitization.",
    },
  },
  Value: {
    stateKey: {
      type: "stateKey",
      required: true,
      semantic: "State key whose current value is rendered inline.",
    },
    fallback: {
      type: "string",
      default: "",
      semantic: "Text shown when the state key is undefined.",
    },
  },
  Code: {
    value: {
      type: "stateKey",
      required: true,
      semantic: "State key holding the source text (e.g. a markdown document).",
    },
    onChange: {
      type: "stateKey",
      required: true,
      semantic: "State key to write on each edit (can equal `value`).",
    },
    language: {
      type: "enum",
      enum: ["markdown", "javascript", "typescript", "json", "plain"],
      default: "markdown",
      semantic: "Syntax highlighting language. Defaults to markdown.",
    },
    placeholder: {
      type: "string",
      default: "",
      semantic: "Placeholder shown when the editor is empty.",
    },
    readOnly: {
      type: "boolean",
      default: false,
      semantic: "Disable editing.",
    },
  },
  Slideshow: {
    value: {
      type: "stateKey",
      semantic:
        "State key holding the full markdown source of the deck. Ignored when `noteId` or `noteTitle` is set.",
    },
    onChange: {
      type: "stateKey",
      semantic:
        "State key written on each edit (typically equals `value`). Ignored when `noteId` or `noteTitle` is set.",
    },
    noteId: {
      type: "noteId",
      semantic:
        "When set, the deck source is loaded read-only from this note's markdown content. Edit mode is disabled.",
    },
    noteTitle: {
      type: "string",
      semantic:
        "Same-project title lookup, alternative to `noteId`. Read-only.",
    },
    indexKey: {
      type: "stateKey",
      semantic:
        "Optional state key for the current slide index. When omitted, the index is component-local and resets on reload.",
    },
    placeholder: {
      type: "string",
      default: "",
      semantic: "Placeholder text shown when the deck source is empty.",
    },
    separator: {
      type: "enum",
      enum: ["hr", "h1"],
      default: "hr",
      semantic:
        "How to split the source into slides. `hr`: split on lines containing only `---`. `h1`: each `# ` heading starts a new slide.",
    },
  },
  PushButton: {
    label: { type: "string", required: true, semantic: "Button label." },
    fromKey: {
      type: "stateKey",
      semantic: "State key whose value is appended (alternative to `value`).",
    },
    value: {
      type: "string",
      semantic: "Static value appended when `fromKey` is absent or empty.",
    },
    toKey: {
      type: "stateKey",
      required: true,
      semantic: "Array state key to append to.",
    },
    clearFrom: {
      type: "boolean",
      default: false,
      semantic: "Reset `fromKey` to empty after the push.",
    },
  },
};
