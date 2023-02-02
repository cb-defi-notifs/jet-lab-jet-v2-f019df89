const cypressConfig = {
  e2e: {
    screenshotOnRunFailure: false,
    video: false,
    viewportWidth: 1280,
    viewportHeight: 720,
    env: {
      hideXHR: true
    },
    baseUrl: 'http://localhost:3000',
    defaultCommandTimeout: 60000,
    testIsolation: false
  }
};

export default cypressConfig;
