FROM node:24-slim

WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar dependências
RUN npm install

# Copiar todo o código
COPY . .

# Criar diretório para dados persistentes
RUN mkdir -p /app/data

# Expor porta para o keep-alive
EXPOSE 3000

# Comando para iniciar o bot
CMD ["node", "bot.js"]
