import { UserService } from '../../services/user';
import { Context, currentContext } from '../../services/context';

async function ensureAdmin(ctx: Context = currentContext()): Promise<void> {
  const user = await UserService.getById(ctx.user.id);

  if (!user.isPlatformAdmin) {
    throw new Error('User is not an admin');
  }
}

export { ensureAdmin };
