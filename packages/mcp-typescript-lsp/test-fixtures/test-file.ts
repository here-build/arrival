interface User {
  id: number;
  name: string;
}

class UserService {
  private readonly users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }

  findUser(id: number): User | undefined {
    return this.users.find((u) => u.id === id);
  }
}

const service = new UserService();
const testUser: User = { id: 1, name: "Test" };
service.addUser(testUser);
