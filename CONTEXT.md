# Skill Distribution Context

This context names the concepts that connect a SkillHub community to dsh skill discovery and use.

## Language

**Skill Center**:
The dsh product area for discovering Community Skills and managing the Personal Skill Inventory.
_Avoid_: Marketplace, SkillHub frontend

**Registry Instance**:
A configured SkillHub service that is authoritative for its own community identities, releases, and downloadable artifacts.
_Avoid_: Marketplace server

**Community Skill**:
A skill published by a Registry Instance and available for discovery or distribution; it is not callable in dsh merely because it appears in the community catalog.
_Avoid_: Remote Skill, available Skill

**Managed Installation**:
A dsh-owned local copy of one exact Community Skill version, together with its enabled state and origin.
_Avoid_: Downloaded Skill, Community Skill

**Personal Skill Inventory**:
The union shown as "My Skills": Managed Installations plus project, user, custom, bundled, and runtime skills visible to dsh.
_Avoid_: Installed Skills

**Resolved Skill**:
The skill definition that dsh would use for a name in one workspace and agent context. It may differ from a Managed Installation with the same name.
_Avoid_: Installed Skill, enabled Skill
