// The switch for everything the system does to subjects on its own. Both flags must be on, so a Worker that has subjects
// off does nothing here whatever SUBJECTS_AUTO says. Writing briefs has a third switch, SUBJECTS_BRIEFS: a brief is a model's reading
// of free text, so it is less certain than a link and the person turns it on separately.

/** True when the system may link, propose, cluster and build briefs by itself. @param {{SUBJECTS?: string, SUBJECTS_AUTO?: string}} env */
export const autoOn = (env) => env?.SUBJECTS_AUTO === "on" && env?.SUBJECTS === "on";

/** True when the nightly step may also write briefs. All three flags must be on. @param {{SUBJECTS?: string, SUBJECTS_AUTO?: string, SUBJECTS_BRIEFS?: string}} env */
export const briefsOn = (env) => autoOn(env) && env?.SUBJECTS_BRIEFS === "on";
