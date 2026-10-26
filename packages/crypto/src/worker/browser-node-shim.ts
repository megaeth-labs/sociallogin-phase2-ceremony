// snarkjs's shared misc module statically imports these Node modules, then
// selects Web Crypto when `process.browser` is true. The worker build defines
// that flag and aliases the unreachable imports to this empty default export.
const unavailableInBrowser = {};
export default unavailableInBrowser;

