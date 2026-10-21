// The switch for everything the system does to subjects on its own. Both flags must be "on", and with either off nothing new happens.
export const autoOn = (env) => env.SUBJECTS === "on" && env.SUBJECTS_AUTO === "on";
