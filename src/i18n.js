// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, feature names, states of
// the status feature, command refusals), in English and French.
// -----------------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts?.[language] ?? texts?.en ?? '';

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  status: { en: 'Status', fr: 'État' },
  'pool-temperature': { en: 'Pool temperature', fr: 'Température piscine' },
  'spa-temperature': { en: 'Spa temperature', fr: 'Température spa' },
  'air-temperature': { en: 'Air temperature', fr: "Température de l'air" },
  'pool-pump': { en: 'Pool pump', fr: 'Pompe de filtration piscine' },
  'spa-pump': { en: 'Spa pump', fr: 'Pompe spa' },
  'pool-heater': { en: 'Pool heater', fr: 'Chauffage piscine' },
  'spa-heater': { en: 'Spa heater', fr: 'Chauffage spa' },
  'solar-heater': { en: 'Solar heater', fr: 'Chauffage solaire' },
  'pool-setpoint': { en: 'Pool set point', fr: 'Consigne piscine' },
  'spa-setpoint': { en: 'Spa set point', fr: 'Consigne spa' },
  ph: { en: 'pH', fr: 'pH' },
  orp: { en: 'Redox (ORP)', fr: 'Redox (ORP)' },
  'pool-salinity': { en: 'Pool salinity (ppm)', fr: 'Salinité piscine (ppm)' },
  'spa-salinity': { en: 'Spa salinity (ppm)', fr: 'Salinité spa (ppm)' },
  temperature: { en: 'Water temperature', fr: "Température de l'eau" },
  'ph-setpoint': { en: 'pH set point', fr: 'Consigne pH' },
  'orp-setpoint': { en: 'ORP set point', fr: 'Consigne ORP' },
  'chlorine-level': {
    en: 'Chlorine production level (%)',
    fr: 'Niveau de production de chlore (%)',
  },
  production: { en: 'Chlorine production', fr: 'Production de chlore' },
  boost: { en: 'Boost', fr: 'Boost' },
  low: { en: 'Low mode (covered pool)', fr: 'Mode réduit (volet fermé)' },
  'filter-pump': { en: 'Filter pump', fr: 'Pompe de filtration' },
  heating: { en: 'Heating', fr: 'Chauffage' },
  'heating-setpoint': { en: 'Heating set point', fr: 'Consigne de chauffage' },
  brightness: { en: 'brightness', fr: 'luminosité' },
};

/** The states of the status feature. */
export const STATUS_TEXT = {
  online: { en: 'Online', fr: 'En ligne' },
  offline: { en: 'Offline', fr: 'Hors ligne' },
  service: { en: 'Service mode', fr: 'Mode service' },
  unknown: { en: 'Unknown', fr: 'Inconnu' },
  error: (code) => ({ en: `error code ${code}`, fr: `code d'erreur ${code}` }),
  lowSalt: { en: 'low salt', fr: 'sel insuffisant' },
};

/** "25 min" / "3 h" / "40 s", for the pauses. */
export function age(ms) {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return { en: `${seconds} s`, fr: `${seconds} s` };
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) {
    return { en: `${minutes} min`, fr: `${minutes} min` };
  }
  const hours = Math.round(minutes / 60);
  return { en: `${hours} h`, fr: `${hours} h` };
}

export const T = {
  noCredentials: {
    en: 'Enter the email and the password of your iAquaLink account (the ones of the iAquaLink app).',
    fr: "Saisissez l'e-mail et le mot de passe de votre compte iAquaLink (ceux de l'application iAquaLink).",
  },
  connecting: {
    en: 'Connecting to iAquaLink…',
    fr: 'Connexion à iAquaLink…',
  },
  connected: (systems, unsupported, offline) => {
    const extraEn = [
      unsupported
        ? `${plural(unsupported, 'other device', 'other devices')} not supported yet`
        : '',
      offline ? `${plural(offline, 'system', 'systems')} offline` : '',
    ].filter(Boolean);
    const extraFr = [
      unsupported
        ? `${plural(unsupported, 'autre appareil', 'autres appareils')} pas encore pris en charge`
        : '',
      offline ? `${plural(offline, 'système', 'systèmes')} hors ligne` : '',
    ].filter(Boolean);
    return {
      en: `Connected to iAquaLink: ${plural(systems, 'pool system', 'pool systems')}${extraEn.length ? ` (${extraEn.join(', ')})` : ''}. Open Discovery to add them.`,
      fr: `Connecté à iAquaLink : ${plural(systems, 'système de piscine', 'systèmes de piscine')}${extraFr.length ? ` (${extraFr.join(', ')})` : ''}. Ouvrez Découverte pour les ajouter.`,
    };
  },
  refused: (wait) => ({
    en: `iAquaLink refused the email or the password: check them in the configuration. Next try in ${wait.en}, or at once after a change.`,
    fr: `iAquaLink a refusé l'e-mail ou le mot de passe : vérifiez-les dans la configuration. Nouvel essai dans ${wait.fr}, ou dès leur modification.`,
  }),
  unreachable: (reason, wait) => ({
    en: `iAquaLink cannot be reached (${reason}). Next try in ${wait.en}.`,
    fr: `iAquaLink est injoignable (${reason}). Nouvel essai dans ${wait.fr}.`,
  }),
  rateLimited: (wait) => ({
    en: `iAquaLink asked to slow down: pausing for ${wait.en}.`,
    fr: `iAquaLink demande de ralentir : pause de ${wait.fr}.`,
  }),
  systemOffline: {
    en: 'iAquaLink reports this system offline (or in service mode).',
    fr: 'iAquaLink signale ce système hors ligne (ou en mode service).',
  },
  denied: {
    commands: {
      en: 'Commands from Gladys are turned off: allow them in the configuration of the iAquaLink integration.',
      fr: "Les commandes depuis Gladys sont désactivées : autorisez-les dans la configuration de l'intégration iAquaLink.",
    },
    offline: {
      en: 'The pool system is offline or in service mode: command refused.',
      fr: 'Le système de piscine est hors ligne ou en mode service : commande refusée.',
    },
    unknown: {
      en: 'The current state of this equipment could not be read just now: a toggle could do the opposite, so the command is refused.',
      fr: "L'état actuel de cet équipement n'a pas pu être lu à l'instant : basculer pourrait faire l'inverse, la commande est donc refusée.",
    },
    moving: {
      en: 'This equipment was just switched and the panel does not report the change yet: command ignored (try again in 30 seconds).',
      fr: "Cet équipement vient d'être commandé et le panneau ne signale pas encore le changement : commande ignorée (réessayez dans 30 secondes).",
    },
    range: (min, max) => ({
      en: `Out of range: the set point must be between ${min} and ${max}.`,
      fr: `Hors limites : la consigne doit être comprise entre ${min} et ${max}.`,
    }),
    budget: {
      en: 'Too many iAquaLink requests in the last minute: try again in a minute.',
      fr: 'Trop de requêtes iAquaLink cette dernière minute : réessayez dans une minute.',
    },
    notReady: {
      en: 'The iAquaLink account is not read yet (or refused): try again later.',
      fr: "Le compte iAquaLink n'est pas encore lu (ou refusé) : réessayez plus tard.",
    },
  },
  test: {
    cooldown: {
      en: 'Already read less than 30 seconds ago.',
      fr: 'Déjà lu il y a moins de 30 secondes.',
    },
    summary: (systems, unsupported, offline) => ({
      en: `${plural(systems, 'supported pool system', 'supported pool systems')}${offline ? ` (${offline} offline)` : ''}${unsupported ? `, ${plural(unsupported, 'other device', 'other devices')} not supported yet` : ''}.`,
      fr: `${plural(systems, 'système de piscine pris en charge', 'systèmes de piscine pris en charge')}${offline ? ` (${offline} hors ligne)` : ''}${unsupported ? `, ${plural(unsupported, 'autre appareil', 'autres appareils')} pas encore pris en charge` : ''}.`,
    }),
  },
};
