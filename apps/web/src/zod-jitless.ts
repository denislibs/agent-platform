import { z } from 'zod';

// Без JIT zod: его проба `new Function` нарушает CSP без 'unsafe-eval' (securitypolicyviolation в e2e). Объектные
// схемы читают настройку при создании, поэтому модуль импортируется в main.tsx первым — раньше схем @agent/shared.
z.config({ jitless: true });
