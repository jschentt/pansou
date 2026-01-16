// 将字符串转换为整数，如果转换失败则返回0
export function stringToInt(s: string): number {
  if (s === '') {
    return 0;
  }
  
  const i = parseInt(s, 10);
  if (isNaN(i)) {
    return 0;
  }
  return i;
}