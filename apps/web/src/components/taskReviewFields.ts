import type {
  PersonProfile,
  Task,
  TaskList,
  TaskPriority,
  TaskResponsiblePerson,
} from "@chief-of-staff-demo/shared";

/** The owner, nobody, or a confirmed Person Profile, as one select value. */
export const OWNER_VALUE = "owner";
export const NOBODY_VALUE = "";

export function responsibleValue(person: TaskResponsiblePerson | null): string {
  if (person === null) return NOBODY_VALUE;
  return person.kind === "owner" ? OWNER_VALUE : person.profileId;
}

export function responsibleFromValue(value: string): TaskResponsiblePerson | null {
  if (value === NOBODY_VALUE) return null;
  return value === OWNER_VALUE ? { kind: "owner" } : { kind: "person-profile", profileId: value };
}

function personName(profiles: PersonProfile[], profileId: string): string {
  return profiles.find((profile) => profile.id === profileId)?.fullName ?? profileId;
}

export function responsibleLabel(
  person: TaskResponsiblePerson | null,
  profiles: PersonProfile[],
): string {
  if (person === null) return "Nobody";
  return person.kind === "owner" ? "You" : personName(profiles, person.profileId);
}

export function listName(lists: TaskList[], listId: string): string {
  return lists.find((list) => list.id === listId)?.name ?? listId;
}

/** The fields an expanded Task form edits, as strings the inputs hold. */
export interface TaskFormValues {
  title: string;
  notes: string;
  dueDate: string;
  priority: TaskPriority;
  listId: string;
  responsible: string;
}

export function formValuesFrom(task: Task): TaskFormValues {
  return {
    title: task.title,
    notes: task.notes,
    dueDate: task.dueDate ?? "",
    priority: task.priority,
    listId: task.listId,
    responsible: responsibleValue(task.responsiblePerson),
  };
}
