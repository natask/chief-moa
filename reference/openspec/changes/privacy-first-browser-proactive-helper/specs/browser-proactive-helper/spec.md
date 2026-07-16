## ADDED Requirements

### Requirement: Context-free local suggestions are not a browser product mode
The browser extension SHALL NOT expose a **Local** or local-suggestions control,
sample page structure to infer generic assistance, render proactive suggestion
cards, or send packaged context-free prompts inferred from structural counts.

#### Scenario: Browser overlay opens on a page
- **WHEN** the extension overlay opens on an ordinary page
- **THEN** Delegate, Help, Collaborate, and other actual interaction roles remain
      available as designed
- **AND** no Local suggestion mode, structural sampler, or proactive card appears
- **AND** no proactive request occurs

#### Scenario: A page contains a table, form, task list, or long document
- **WHEN** page structure matches the retired classifier's affordance rules
- **THEN** the extension does not infer or display a generic suggestion from
      those counts
- **AND** the page structure alone does not create intent or authorize context
      release

### Requirement: Privacy connectivity defaults survive proactive removal
Fresh and migrated installations SHALL NOT persist or contact a packaged hosted
gateway merely because the extension loaded. All remote browser claim polling
and heartbeat SHALL require current versioned background-automation consent and
SHALL fail closed. Heartbeat SHALL exclude page and active-owner metadata.

#### Scenario: Existing install migrates after proactive removal
- **WHEN** the updated extension starts
- **THEN** any obsolete proactive grant or confirmation state is discarded
- **AND** user-saved gateway credentials and valid background-automation consent
      remain governed by their independent settings
- **AND** startup makes no request solely because the retired feature existed

### Requirement: A future context flow is explicit and useful
Any replacement page-context flow SHALL let the user select concrete context
types, inspect the local transformation and exact outbound payload, and approve
the release before it is sent. It SHALL permit useful combinations such as page
text without a screenshot and SHALL NOT equate privacy with context-free model
input.

#### Scenario: User requests a summary without a screenshot
- **WHEN** a future supported flow lets the user include page text and exclude
      screenshots
- **THEN** local extraction may summarize or redact the selected text and
      preserve a local version when requested
- **AND** the user sees and may edit the exact outbound context and destination
      before approval
- **AND** only the approved context enters the normal browser-turn boundary

#### Scenario: User wants richer model understanding
- **WHEN** the user explicitly approves more relevant page context
- **THEN** the product may send that richer bounded context
- **AND** it clearly distinguishes collection, local retention/transformation,
      and outbound release instead of silently minimizing usefulness
