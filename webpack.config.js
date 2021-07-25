const path = require('path')

module.exports = {
	mode: 'development',
	entry: './src/index.ts',
	output: {
		path: path.join(__dirname, 'dist'),
		filename: 'qbasic-vm.js',
		library: 'qbasic-vm',
		libraryTarget: 'umd',
	},
	devtool: 'source-map',
	resolve: {
		modules: [path.resolve('./node_modules'), path.resolve('./src')],
		extensions: ['.js', '.ts', '.json']
	},
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				exclude: /node_modules/,
				use: {
					loader: 'ts-loader',
					options: {
						transpileOnly: false
					}
				}
			}
		]
	},
	devServer: {
		contentBase: [
			path.join(__dirname, 'demo'),
			path.join(__dirname, 'assets'),
			path.join(__dirname, 'dist')
		],
		compress: true,
		port: 9000,
		open: true,
		openPage: 'index.html',
		watchContentBase: true,
		filename: 'qbasic-vm.js'
	},
}
