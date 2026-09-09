const startCasedFirstname = (username: string) => {
  const firstName = username.split(' ')[0];
  return firstName[0].toUpperCase() + firstName.slice(1);
};
export { startCasedFirstname };
