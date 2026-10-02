// @vitest-environment node
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
const redis=vi.hoisted(()=>({isOpen:false,isReady:false,connect:vi.fn(),eval:vi.fn(),on:vi.fn()}))
vi.mock('redis',()=>({createClient:()=>redis}))
beforeEach(()=>{vi.resetModules();vi.resetAllMocks();redis.isOpen=false;redis.isReady=false;vi.stubEnv('REDIS_URL','redis://localhost:6379');redis.connect.mockImplementation(async()=>{redis.isOpen=true;redis.isReady=true});redis.eval.mockResolvedValue([1,19,0])})
afterEach(()=>vi.unstubAllEnvs())
it('waits for Redis connection before allowing the first send',async()=>{const {checkRateLimit}=await import('../cloud-api/rate-limiter');expect((await checkRateLimit('12345')).allowed).toBe(true);expect(redis.connect).toHaveBeenCalledTimes(1);expect(redis.eval).toHaveBeenCalledTimes(1)})
it('blocks sending when Redis fails',async()=>{redis.connect.mockRejectedValue(new Error('connection failed'));const {checkRateLimit}=await import('../cloud-api/rate-limiter');expect((await checkRateLimit('12345')).allowed).toBe(false);expect(redis.eval).not.toHaveBeenCalled()})
it('blocks sending when Redis is not configured',async()=>{vi.stubEnv('REDIS_URL','');const {checkRateLimit}=await import('../cloud-api/rate-limiter');expect((await checkRateLimit('12345')).allowed).toBe(false)})
