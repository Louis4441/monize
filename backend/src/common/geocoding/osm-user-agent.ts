/**
 * The User-Agent every OpenStreetMap request from this deployment carries.
 *
 * Both OSM services this codebase talks to -- Nominatim for geocoding and the
 * tile server for map imagery -- require a request to identify the application
 * behind it, and answer an anonymous one with a 403. It is one constant because
 * it is one claim about who is calling: split in two, the halves drift and only
 * one of them gets updated when the project moves.
 */
export const OSM_USER_AGENT =
  "Monize/1.0 (self-hosted personal finance; +https://github.com/kenlasko/monize)";
