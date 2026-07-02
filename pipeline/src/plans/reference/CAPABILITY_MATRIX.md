# Reference Plan Capability Matrix

| Plan | Key purpose | Roles | Associations | Popup | List view | Data view | Data grid | Filter toolbar | Microflows | Nanoflows | Workflow start | Workflow inbox/task UI | Outcome buttons | Routing | Association selectors | Open link | Create app |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `reference-01-role-separated-crud.json` | Role-separated CRUD baseline | Yes | No | Yes | Yes | Yes | No | No | No | No | No | No | No | No | No | No | No |
| `reference-02-workflow-simple-approval.json` | Simple approval workflow | Yes | No | Yes | Yes | Yes | No | No | Yes | No | Yes | Yes | Yes | No | No | No | No |
| `reference-03-relational-crud.json` | Multi-entity relational CRUD | Yes | Yes | Yes | Yes | Yes | No | No | No | No | No | No | No | No | Yes | No | No |
| `reference-04-microflow-business-logic.json` | Non-workflow business logic | Yes | No | Yes | Yes | Yes | No | No | Yes | No | No | No | No | No | No | No | No |
| `reference-05-analytics-filters.json` | Role-aware operations CRUD and monitoring board | Yes | Yes | Yes | Yes | Yes | No | No | No | No | No | No | No | No | Yes | No | No |
| `reference-06-workflow-routing.json` | HR case multi-step workflow routing | Yes | No | Yes | Yes | Yes | No | No | Yes | No | Yes | Yes | Yes | Yes | No | No | No |
| `reference-07-client-actions-create-app.json` | Client actions plus app creation | Yes | No | Yes | Yes | Yes | No | No | No | Yes | No | No | No | No | No | Yes | Yes |

## Maintenance Rules

- The reference suite is the only prompt example corpus for `useExamples=true`.
- Every reference plan must keep `execution.commit` set to `true`.
- No reference plan may include chart widgets.
- Reference-plan navigation icons are optional; if present, they must be `{ "name": "home" }`.
- Every reference plan must validate cleanly with `node src/commander.js <plan> --validate-only`.
- If a new reference plan is added, this matrix must be updated to show the unique capability it contributes.
