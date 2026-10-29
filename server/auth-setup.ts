import {loadLocalEnv} from './env.ts';
loadLocalEnv();
import {AuthStore, defaultAuthDirectory} from './auth.ts';
const auth=new AuthStore(defaultAuthDirectory());
await auth.init();
try {process.stdout.write(`One-time setup code (expires in 15 minutes):\n${auth.setSetupToken()}\nOpen the sign-in dialog to create your administrator account.\n`);} finally {auth.close();}

