// The switch for everything the system does to subjects on its own. Both flags must be on, so a Worker that has subjects
// off does nothing here whatever SUBJECTS_AUTO says.

/** True when the system may link, propose, cluster and build briefs by itself. @param {{SUBJECTS?: string, SUBJECTS_AUTO?: string}} env */
export const autoOn = (env) => env?.SUBJECTS_AUTO === "on" && env?.SUBJECTS === "on";
