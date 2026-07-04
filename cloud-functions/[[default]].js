// EdgeOne Pages Node Function entry point.
// This is the ONLY file EdgeOne treats as a route in this folder (name must be
// [[default]].js). It just imports the existing Express app from server.js and
// re-exports it - all routing, middleware, and business logic stays untouched
// in server.js / routes / services.
//
// Static files (ranked.html, ranked-admin.html, ranked-config.js, dashboard.html,
// etc.) should live in your project's static output directory - EdgeOne serves
// those directly at the edge and only falls through to this function for
// everything else (/, /health, /api/*, and any other dynamic path).
import app from '../server.js';
export default app;
