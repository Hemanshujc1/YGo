# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Only `ready-for-agent`, `ready-for-human` and `wontfix` exist in the tracker today. `needs-triage` and `needs-info` have never been needed, because the owner files every issue; create them the first time an issue needs one.

## Category labels

Every build ticket carries exactly one `type:` label. These replace the skills' `bug` / `enhancement` categories.

| Label in our tracker | Meaning                                       | Skill category it stands in for |
| -------------------- | --------------------------------------------- | ------------------------------- |
| `type:feature`       | User-facing vertical slice                    | `enhancement`                   |
| `type:task`          | Foundation, tooling or coverage work          | `enhancement`                   |
| `type:docs`          | Documentation                                 | `enhancement`                   |

There is no `type:bug` yet. GitHub's default `bug` label exists but has never been used; apply it if a defect is reported.

## Issues outside triage

- `wayfinder:*` issues (the decision map #1 and its children) are planning records. They carry no state label.
- A parent issue whose work is split into sub-issues, or a specification that tickets reference (#28), carries no state label, so an agent picks up the sub-issues instead of the parent.

Edit the right-hand column to match whatever vocabulary you actually use.
