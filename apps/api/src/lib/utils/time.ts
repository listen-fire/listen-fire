import { MINUTE, SECOND } from '../../constants';

function getTimeDifference(a: Date, b: Date) {
  const diffInMilliseconds = Math.abs(b.getTime() - a.getTime());
  const minutes = Math.floor(diffInMilliseconds / MINUTE);
  const seconds = Math.floor((diffInMilliseconds % MINUTE) / SECOND);

  return { minutes, seconds };
}

export { getTimeDifference };
