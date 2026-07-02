## JSON Plan Structure (v1.0 additive)

Top-level sections currently supported:
1. `meta` (optional)
2. `app` (required)
3. `execution` (optional)
4. `packs` (optional)
5. `domainModel` (optional)
6. `security` (optional)
7. `microflows` (optional)
8. `nanoflows` (optional)
9. `workflows` (optional, DSL-only)
10. `pages` (optional)
11. `personas` (optional)
12. `verification` (optional)

At least one of `domainModel`, `security`, `microflows`, `nanoflows`, `workflows`, `pages` must be present.

`meta` is reserved for minimal plan provenance such as `planVersion`, `generatedAt`, `generatedBy`, and merge/debug flags. Generator diagnostics such as story coverage, domain model review results, dropped entities, and capability scoring belong in `generation-report.json`, not in the build plan.

## Schema files

Machine-readable schemas are in:

- `src/plans/schema/plan.schema.json`
- `src/plans/schema/domain-model.schema.json`
- `src/plans/schema/pages.schema.json`
- `src/plans/schema/microflows.schema.json`
- `src/plans/schema/workflows.schema.json`
- `src/plans/schema/security.schema.json`

Use `node src/commander.js <plan.json> --validate-only` (or `npm run validate:plan --plan=<plan.json>`) to validate against schema and runtime guards.

## Canonical plans

Official reference plans:

- `src/plans/reference/reference-01-role-separated-crud.json`
- `src/plans/reference/reference-02-workflow-simple-approval.json`
- `src/plans/reference/reference-03-relational-crud.json`
- `src/plans/reference/reference-04-microflow-business-logic.json`
- `src/plans/reference/reference-05-analytics-filters.json`
- `src/plans/reference/reference-06-workflow-routing.json`
- `src/plans/reference/reference-07-client-actions-create-app.json`

Legacy and scratch plans remain under `src/plans/`, while scratch/working plans belong in `src/plans/_scratch/`.

## Optional Recommended Archetypes

The planner and builders support a few generic page archetypes that are useful in many Mendix apps, but they are optional patterns, not mandatory structure.

- `home_hub`
  - title
  - subtitle
  - `buttonToPage` shortcuts to important pages chosen by the plan
- `dashboard_listview`
  - title
  - description
  - database-backed `listView`
  - `createObjectButton` with caption like `Add <Entity>`
  - optional row click to a matching popup NewEdit page
- `popup_newedit`
  - `layoutQualifiedName: "Atlas_Core.PopupLayout"`
  - context-bound `dataView`
  - standard editable inputs for the target entity
  - `saveChangesButton` and `cancelChangesButton` with `closePage: true`

These archetypes should be selected only when they fit the stories or the manual plan. They must remain parameterized by entity, roles, captions, and targets. Do not hardcode domain-specific content into them.

`app` options for homepage:
- `homePageRef` (preferred): page `ref` from `pages.specs`
- `homePageName`: page name (module-local or qualified)
- `homePageQualifiedName`: explicit fully qualified page name
- `navigation`:
  - `homePageButtons`: rich homepage navigation entries `{ pageRef, caption?, icon?, allowedRoles? }`
  - `menuItems`: rich web navigation entries `{ pageRef, caption?, icon?, allowedRoles? }`
  - `homePageButtonRefs` / `navigationItemRefs`: legacy ref-only arrays, still accepted and normalized

Icon guidance:
- Icons are optional.
- If an icon is provided, use only `icon: { "name": "home" }`.
- Numeric icon codes and arbitrary icon names are rejected.

## Example

```json
{
  "meta": {
    "planVersion": "1.0.0",
    "generatedAt": "2026-03-02T12:00:00Z",
    "generatedBy": "pipeline.plan-generator"
  },
  "app": {
    "appId": "326c56f7-ca03-4358-99a1-c89fea95cd07",
    "branch": "main",
    "moduleName": "MyFirstModule",
    "layoutQualifiedName": "Atlas_Core.Atlas_Default",
    "homePageRef": "home"
  },
  "execution": {
    "commit": true,
    "seedAppId": "4b97710b-8a1a-4971-a724-a376a995f91e",
    "createAppName": "US2LC Library Demo",
    "commitMessage": "Generate prototype"
  },
  "domainModel": {
    "entities": [
      {
        "name": "Task",
        "attributes": [
          { "name": "Title", "type": "String", "required": true },
          { "name": "IsApproved", "type": "Boolean", "required": true, "defaultValue": false }
        ]
      }
    ],
    "associations": [],
    "enumerations": []
  },
  "security": {
    "enabled": true,
    "securityLevel": "prototype",
    "moduleRoles": ["Manager", "Employee"],
    "userRoles": [
      {
        "name": "Manager",
        "moduleRoles": ["Manager"],
        "systemModuleRole": "System.Administrator"
      },
      {
        "name": "Employee",
        "moduleRoles": ["Employee"],
        "systemModuleRole": "System.User"
      }
    ],
    "demoUsers": [
      { "userName": "demo_manager", "password": "Manager123!", "userRoles": ["Manager"] },
      { "userName": "demo_employee", "password": "Employee123!", "userRoles": ["Employee"] }
    ]
  },
  "microflows": {
    "specs": [
      {
        "ref": "mf_prepare",
        "name": "MF_PrepareTask",
        "actions": [
          { "type": "showMessage", "message": "Preparing task" }
        ]
      }
    ]
  },
  "nanoflows": {
    "specs": [
      {
        "ref": "nf_ping",
        "name": "NF_ClientPing",
        "actions": [
          { "type": "showMessage", "message": "Client ping" }
        ]
      }
    ]
  },
  "workflows": {
    "specs": [
      {
        "ref": "wf_task",
        "name": "WF_Task",
        "bindings": { "contextEntityRef": "MyFirstModule.Task" },
        "steps": [
          { "type": "start", "name": "Start" },
          { "type": "serviceTask", "name": "Prepare", "handlerMicroflowRef": "mf_prepare" },
          { "type": "userTask", "name": "Review", "taskPageRef": "task_detail" },
          { "type": "end", "name": "Done" }
        ]
      }
    ]
  },
  "pages": {
    "specs": [
      {
        "ref": "task_overview",
        "name": "Task_Overview",
        "title": "Task Overview",
        "entityRef": "MyFirstModule.Task",
        "persona": "Admin",
        "content": [
          { "type": "dynamicText", "text": "Tasks", "renderMode": "H2" },
          { "type": "callMicroflowButton", "caption": "Run Prepare", "microflowRef": "mf_prepare" },
          { "type": "callNanoflowButton", "caption": "Ping", "nanoflowRef": "nf_ping" },
          { "type": "callWorkflowButton", "caption": "Start Workflow", "workflowRef": "wf_task" },
          { "type": "openLinkButton", "caption": "Open Mendix", "url": "https://www.mendix.com" }
        ]
      },
      {
        "ref": "task_detail",
        "name": "Task_Detail",
        "title": "Task Detail",
        "parameterEntityRef": "MyFirstModule.Task",
        "entityRef": "MyFirstModule.Task",
        "persona": "Admin",
        "content": [
          {
            "type": "dataView",
            "pageParameterName": "Task",
            "content": [
              { "type": "attributeInput", "attributeRef": "Title" },
              { "type": "attributeInput", "attributeRef": "IsApproved" },
              { "type": "saveChangesButton", "caption": "Save" },
              { "type": "deleteObjectButton", "caption": "Delete", "closePage": true },
              { "type": "closePageButton", "caption": "Close" }
            ]
          }
        ]
      }
    ]
  },
  "personas": {
    "enabled": true,
    "specs": [
      { "name": "Admin" },
      { "name": "Parent" },
      { "name": "Staff" }
    ]
  },
  "verification": {
    "failOnMissing": true
  }
}
```

## Page Archetype Notes

- `pages.specs[].layoutQualifiedName` can override the app-level default layout for a specific page.
- `pages.specs[].layoutParameterQname` can be provided when a non-default layout needs an explicit target region.
- One recommended optional pattern is:
  - `Home`: title, subtitle, and `buttonToPage` shortcuts to key pages
  - `*_Dashboard` or `*_Overview`: title, description, a database-backed `listView`, and a `createObjectButton` pointing to a popup NewEdit page
  - `*_NewEdit`: popup page with `layoutQualifiedName: "Atlas_Core.PopupLayout"`, a context-bound `dataView`, `labelWidth: 3`, and `saveChangesButton` / `cancelChangesButton` that close the page
- Treat this as an archetype the planner may choose, not as a requirement for every generated app.
- The planner should keep these archetypes generic and parameterized by entity, roles, and navigation targets rather than story-specific hardcoding.

## Supported page `content[].type`

- `dynamicText`
- `buttonToPage`
- `createObjectButton`
- `listView`
- `dataGrid`
- `dataView`
- `associationInput`
- `associationSetInput`
- `referenceSelector` (alias of `associationInput`)
- `referenceSetSelector` (alias of `associationSetInput`)
- `filterToolbar`
- `attributeInput`
- `saveChangesButton`
- `cancelChangesButton`
- `callMicroflowButton`
- `callNanoflowButton`
- `callWorkflowButton`
- `showUserTaskPageButton`
- `setTaskOutcomeButton`
- `deleteObjectButton`
- `closePageButton`
- `openLinkButton`
- `widget`

## Domain model association note

- `domainModel.associations[].owner` is optional and accepts `Both` or `Default`.
- If omitted, generator default is `Both` (recommended for prototype lookup/navigation compatibility).
- For self-referential associations (`parentEntity === childEntity`), owner is automatically forced to `Default` (Mendix compile rule CE0002).

## Reserved attribute names

- Generator automatically rewrites reserved member names in domain attributes to compile-safe alternatives.
- Current protected names: `id`, `owner`, `changedBy`, `changedDate`, `createdDate`.
- Rewrite results are returned in commander output under `reservedWordSanitization`.

## Execution flags

- `execution.seedAppId` (optional)
  - Run the plan against an existing seed app instead of a blank newly created app.
  - Useful when you want to start from a known-good manual app baseline.
  - When provided, commander targets that app directly and does not call `createNewApp()` for the run.
- `execution.forceLegacyWebClientForLookups` (optional, default `true`)
  - When lookup steps (`associationInput` / `associationSetInput`) are present, commander sets `WebUI.useOptimizedClient = No` to keep native selector widgets compile-safe.

Step options:
- `saveChangesButton.closePage` (optional, default `true` in this generator)
- `saveChangesButton.syncAutomatically` (optional boolean)
- `setTaskOutcomeButton.outcomeValue` (optional string, defaults to `Complete`)
- `attributeInput.events.onChangeMicroflowRef` / `attributeInput.events.onChangeNanoflowRef`
- `attributeInput.events.callType` (`synchronous` or `asynchronous`; microflow on-change only)
- `listView.rowClickTargetPageRef` (optional explicit detail target)
- `listView.autoRowClickToDetail` (optional boolean, default `true`)
  - when enabled and no `rowClickTargetPageRef` is provided, the builder auto-binds list row click to a matching detail/edit page that has exactly one required parameter of the same entity type
- `associationInput` / `associationSetInput`:
  - `targetEntityRef` (recommended)
  - `associationRef` (optional explicit association override)
  - `displayAttributeRef` (optional display member on target entity)

## Data Grid DSL

`dataGrid` is supported again in strict deterministic mode.

For the standard generated app baseline, the planner now prefers `listView` for dashboard and management pages because it is the most repeatable supported pattern across fresh apps. Use `dataGrid` only when a plan explicitly asks for it.

Supported contract:

- `entityRef`
- `columns[]`
- `search.fields[]`
- `rowClickTargetPageRef`
- `pageSize`
- `widgetMode`

Modes:

- `classic`: uses Mendix `DataGrid` APIs and supports search plus default-row open behavior
- `datagrid2` / `dg2`: uses the existing Data Grid 2 custom-widget path for minimal deterministic grids
- omitted: execution defaults are determined by the explicit plan; there is no baseline preference for `dataGrid` anymore

## Filter Toolbar DSL

`filterToolbar` remains available as legacy convenience syntax for explicit filter-state UIs.
It pairs naturally with searchable data-management pages.

Legacy example:

```json
{
  "type": "filterToolbar",
  "stateEntityRef": "MyFirstModule.TaskFilterState",
  "bindings": {
    "statusAttributeRef": "StatusFilter",
    "searchTextAttributeRef": "SearchText"
  },
  "onChangeMicroflowRef": "mf_todo_refresh"
}
```

It can also accept explicit nested `content`.

## Execution flags

`execution.dg2Cleanup` controls pre-generation cleanup of planned DG2 pages.

- default: `true`
- behavior: interface-level deletion of targeted planned pages before regeneration, to remove stale/broken DG2 artifacts from prior runs.

## Microflow/Nanoflow DSL action types

Supported actions:
- `showMessage`
- `callMicroflow`
- `callNanoflow`
- `retrieveList`
- `retrieveObject`
- `createObject`
- `aggregateList`
- `createVariable`
- `changeVariable`
- `decision`
- `changeObject`
- `commitObject`
- `returnValue`

Expression fields use Mendix expression syntax directly (for example `$BillTotal * $TipPercentage div 100`).

`aggregateList` guidance:
- Use `aggregateFunction: "Count"` for list counts.
- Provide `listVariableName` and `outputVariableName`.
- For `Sum`/`Average`/`Minimum`/`Maximum`, provide `attributeRef`.

## Workflow DSL notes

- BPMN fields (`bpmnSources`, `bpmnSourceId`, `bpmn`) are rejected in this phase.
- Each workflow requires `bindings.contextEntityRef` and `steps`.
- `callWorkflowButton` must be placed inside a data container whose context entity matches the workflow context entity.
- `showUserTaskPageButton` opens a `System.WorkflowUserTask` from a workflow task inbox/list context.
- In Mendix 11.7, `callWorkflowButton` does not auto-persist a new object. Save first (or use an already persisted object) before starting the workflow.
- `userTask.taskPageRef` should reference a page with a required page parameter of type `System.WorkflowUserTask`.
- `userTask` assignment targeting defaults to XPath `[not(IsAnonymous)]` when no explicit user-assignment XPath is provided.
- `userTask.userRoleRefs[]` / `userTask.targetUserRoleRefs[]` can be used for deterministic role-based assignment targeting.
- Automatic workflow role targeting requires role names that use only letters, digits, and underscores; otherwise provide `userAssignmentXPath` explicitly.
- Avoid using `[%CurrentUser%]` in workflow user-targeting XPath, because targeting is evaluated in a system session.
- Supported workflow step types:
  - `start`
  - `serviceTask`
  - `userTask`
  - `exclusiveGateway`
  - `end`

## Security notes

- `security.securityLevel` supports: `none`/`off`, `prototype`, `production`.
- `security.moduleRoles` creates module roles in `app.moduleName`.
- `security.userRoles[].moduleRoles` maps project roles to module roles.
- `security.userRoles[].systemModuleRole` can force a specific System module role (for example `System.Administrator`, `System.User`).
- `security.userRoles[].systemSourceUserRole` can copy module-role assignments from an existing project role (for example `Administrator`, `User`).
- `security.demoUsers` creates login users with credentials for prototype testing.
- Prefer explicit, non-generic demo usernames such as `demo_manager` and `demo_employee` over bare role names.
- `pages.specs[].allowedRoles[]` is the deterministic page-visibility contract.
- `app.navigation.homePageButtons[].allowedRoles[]` applies conditional visibility to homepage buttons.
- `app.navigation.menuItems[].allowedRoles[]` is normalized and checked against the target-page visibility contract.
- Default mapping if omitted:
  - user role `Manager` gets System role target `System.User` and source `User`
  - user role `Employee` gets System role target `System.User` and source `User`
- Business roles such as `Manager`, `Supervisor`, `Lead`, and `Employee` should normally use `System.User`.
- Reserve `System.Administrator` for true administrative access, and set it explicitly in the plan when needed.

## Generic Custom Widgets

`widget` steps can now describe custom/pluggable widgets with `widgetId`.

Deterministic contract:

- `widgetId`
- optional `widgetName`
- optional `propertyTypes[]` when plan-defined metadata is needed
- `props`

Charts should use this generic custom-widget path rather than a chart-specific DSL.

## Verification options

```json
{
  "verification": {
    "failOnMissing": true,
    "scope": "generatedModule",
    "semanticChecks": {
      "uniqueWidgetNames": true,
      "pageParameterCompatibility": true,
      "workflowBindings": true,
      "securitySystemRoles": true
    }
  }
}
```

- `scope` currently supports only `generatedModule`.
- Semantic checks are plan-scoped guardrails and fail the pipeline before commit when enabled.
